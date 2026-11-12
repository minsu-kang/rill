import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LlmError, MAX_SSE_EVENT_BYTES, SseParser, readSse, type SseEvent } from '../src/index'

const encoder = new TextEncoder()

function streamOf(chunks: readonly (string | Uint8Array)[], then: 'end' | 'hold' | 'error' = 'end') {
  const state = { cancelled: false, pulls: 0 }
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1
      const chunk = chunks[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      } else if (then === 'end') controller.close()
      else if (then === 'error') controller.error(new TypeError('terminated'))
      else return new Promise<void>(() => undefined)
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { stream, state }
}

async function collect(chunks: readonly (string | Uint8Array)[], signal?: AbortSignal): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const event of readSse(streamOf(chunks).stream, signal)) out.push(event)
  return out
}

describe('readSse', () => {
  it('reads events with and without an event name', async () => {
    expect(await collect(['event: a\ndata: {"x":1}\n\ndata: plain\n\n'])).toEqual([{ event: 'a', data: '{"x":1}' }, { data: 'plain' }])
  })

  it('joins several data lines with a newline and strips one leading space only', async () => {
    expect(await collect(['data: one\ndata:  two\ndata:three\n\n'])).toEqual([{ data: 'one\n two\nthree' }])
  })

  it('handles events split at every byte boundary', async () => {
    const text = 'event: x\ndata: {"a":"é€😀"}\n\ndata: second\n\n'
    const bytes = encoder.encode(text)
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))
    expect(await collect(chunks)).toEqual([{ event: 'x', data: '{"a":"é€😀"}' }, { data: 'second' }])
  })

  it('does not break a multi-byte character that is split across two chunks', async () => {
    const bytes = encoder.encode('data: 😀\n\n')
    const events = await collect([bytes.slice(0, 8), bytes.slice(8)])
    expect(events).toEqual([{ data: '😀' }])
  })

  it('accepts CRLF, lone CR and a CRLF split between chunks', async () => {
    expect(await collect(['data: a\r\n\r\ndata: b\r\r', 'data: c\r', '\n\r', '\n'])).toEqual([{ data: 'a' }, { data: 'b' }, { data: 'c' }])
  })

  it('ignores comment lines, id and retry fields and a leading byte order mark', async () => {
    expect(await collect(['﻿: keep-alive\nid: 7\nretry: 100\ndata: x\n\n: tail\n\n'])).toEqual([{ data: 'x' }])
  })

  it('does not dispatch an event without data and resets the event name', async () => {
    expect(await collect(['event: lonely\n\ndata: x\n\n'])).toEqual([{ data: 'x' }])
  })

  it('drops an event that is not terminated by a blank line when the stream ends', async () => {
    expect(await collect(['data: whole\n\ndata: cut'])).toEqual([{ data: 'whole' }])
  })

  it('stops at the [DONE] marker and cancels the body', async () => {
    const { stream, state } = streamOf(['data: a\n\ndata: [DONE]\n\ndata: after\n\n'], 'hold')
    const out: SseEvent[] = []
    for await (const event of readSse(stream)) out.push(event)
    expect(out).toEqual([{ data: 'a' }])
    expect(state.cancelled).toBe(true)
  })

  it('drops a byte order mark at the very start of the stream, and only there', async () => {
    expect(new SseParser().push('\ufeffdata: a\n\n')).toEqual([{ data: 'a' }])
    const parser = new SseParser()
    expect(parser.push('data: a\n\n')).toEqual([{ data: 'a' }])
    expect(parser.push('\ufeffdata: b\n\n')).toEqual([])
    const late = new SseParser()
    expect(late.push('')).toEqual([])
    expect(late.push('\ufeffdata: c\n\n')).toEqual([{ data: 'c' }])
  })

  it('waits for the next chunk when a chunk ends on a lone CR, so CR then LF is one line end', () => {
    const parser = new SseParser()
    expect(parser.push('data: x\r')).toEqual([])
    expect(parser.push('\ndata: y\r\n\r\n')).toEqual([{ data: 'x\ny' }])
  })

  it('treats a CR at the very end of the stream as a line end', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\r\r')).toEqual([])
    expect(parser.end()).toEqual([{ data: 'a' }])
  })

  it('allows exactly the size limit for an unfinished event and refuses one byte more', () => {
    const exact = new SseParser()
    expect(() => exact.push(`data: ${'a'.repeat(MAX_SSE_EVENT_BYTES - 6)}`)).not.toThrow()
    const over = new SseParser()
    expect(() => over.push(`data: ${'a'.repeat(MAX_SSE_EVENT_BYTES - 5)}`)).toThrow(LlmError)
  })

  it('treats a [DONE] marker inside a longer data value as ordinary data', async () => {
    expect(await collect(['data: x [DONE]\n\n'])).toEqual([{ data: 'x [DONE]' }])
  })

  it('accepts an event just under the size limit and rejects one over it', async () => {
    const big = 'a'.repeat(MAX_SSE_EVENT_BYTES - 1024)
    expect(await collect([`data: ${big}\n\n`])).toHaveLength(1)
    const act = collect([`data: ${'a'.repeat(MAX_SSE_EVENT_BYTES + 1)}`, '\n\n'])
    await expect(act).rejects.toBeInstanceOf(LlmError)
    await expect(act).rejects.toMatchObject({ kind: 'invalid_output' })
  })

  it('counts several data lines of one event together against the limit', async () => {
    const line = `data: ${'b'.repeat(MAX_SSE_EVENT_BYTES / 2)}\n`
    await expect(collect([line, line, line, '\n'])).rejects.toMatchObject({ kind: 'invalid_output' })
  })

  it('cancels and releases the body when the consumer stops early', async () => {
    const { stream, state } = streamOf(['data: a\n\ndata: b\n\n'], 'hold')
    for await (const event of readSse(stream)) {
      expect(event.data).toBe('a')
      break
    }
    expect(state.cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('rejects when the signal is already aborted, without reading', async () => {
    const controller = new AbortController()
    controller.abort()
    const { stream, state } = streamOf(['data: a\n\n'])
    await expect(async () => {
      for await (const event of readSse(stream, controller.signal)) void event
    }).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.pulls).toBe(0)
    expect(state.cancelled).toBe(true)
  })

  it('closes the reader and rejects when the signal aborts while a read is pending', async () => {
    const controller = new AbortController()
    const { stream, state } = streamOf(['data: a\n\n'], 'hold')
    const seen: string[] = []
    const run = (async () => {
      for await (const event of readSse(stream, controller.signal)) seen.push(event.data)
    })()
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toEqual(['a'])
    expect(state.cancelled).toBe(true)
    expect(stream.locked).toBe(false)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('passes a read error through and still releases the body', async () => {
    const { stream } = streamOf(['data: a\n\n'], 'error')
    const seen: string[] = []
    await expect(async () => {
      for await (const event of readSse(stream)) seen.push(event.data)
    }).rejects.toThrow('terminated')
    expect(seen).toEqual(['a'])
    expect(stream.locked).toBe(false)
  })

  it('removes its abort listener after a normal end', async () => {
    const controller = new AbortController()
    await collect(['data: a\n\n'], controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('SseParser', () => {
  it('returns events as soon as the blank line arrives', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\n')).toEqual([])
    expect(parser.push('\ndata: b\n\n')).toEqual([{ data: 'a' }, { data: 'b' }])
  })
})
