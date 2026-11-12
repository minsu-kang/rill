import { LlmError } from './types'

export interface SseEvent {
  event?: string
  data: string
}

export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024
const DONE = '[DONE]'
const LINE_END = /\r\n|\n|\r/g

export class SseParser {
  private buffer = ''
  private data: string[] = []
  private event: string | undefined
  private pending = 0
  private started = false

  push(text: string): SseEvent[] {
    if (!this.started && text !== '') {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    this.buffer += text
    return this.drain(false)
  }

  end(text = ''): SseEvent[] {
    this.buffer += text
    return this.drain(true)
  }

  private drain(final: boolean): SseEvent[] {
    const out: SseEvent[] = []
    const buffer = this.buffer
    let start = 0
    LINE_END.lastIndex = 0
    for (let match = LINE_END.exec(buffer); match !== null; match = LINE_END.exec(buffer)) {
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) break
      this.line(buffer.slice(start, match.index), out)
      start = match.index + match[0].length
    }
    this.buffer = buffer.slice(start)
    if (this.buffer.length + this.pending > MAX_SSE_EVENT_BYTES) {
      throw new LlmError('invalid_output', `the model provider sent a stream event larger than ${MAX_SSE_EVENT_BYTES / (1024 * 1024)} MiB`)
    }
    return out
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push(this.event === undefined ? { data: this.data.join('\n') } : { event: this.event, data: this.data.join('\n') })
      this.data = []
      this.event = undefined
      this.pending = 0
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
    else return
    this.pending += value.length + 1
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined)
  const check = () => {
    if (signal?.aborted === true) throw abortReason(signal)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      check()
      const { done, value } = await reader.read()
      check()
      const events = done ? parser.end(decoder.decode()) : parser.push(decoder.decode(value, { stream: true }))
      for (const event of events) {
        if (event.data === DONE) return
        yield event
      }
      if (done) return
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
