import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LlmError, postJson, postStream, startCall, type SseEvent } from '../src/index'
import { createFakeTransport, errorReply, jsonReply, sseReply, type FakeTransport } from './fake-transport'

const events = [{ data: { n: 1 } }, { event: 'done', data: { n: 2 } }]

function request(transport: FakeTransport, timeoutMs = 5000, signal?: AbortSignal) {
  const call = startCall(timeoutMs, signal)
  return {
    call,
    base: { url: 'https://vendor.test/v1/x', headers: { authorization: `Bearer ${transport.apiKey}` }, body: { hello: 'world' }, fetch: transport.fetch, call, secrets: [transport.apiKey] },
  }
}

async function drain(stream: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

const fails = (promise: Promise<unknown>): Promise<LlmError> =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as LlmError,
  )

const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

describe('startCall', () => {
  it('rejects a timeout that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, 2 ** 31]) expect(() => startCall(bad)).toThrow(LlmError)
  })

  it('reports a timeout once the time is up and a cancel when the caller aborts', async () => {
    const short = startCall(10)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(short.abortError()).toMatchObject({ kind: 'timeout' })
    expect(short.abortError().message).toContain('10 ms')
    short.dispose()
    const controller = new AbortController()
    const call = startCall(5000, controller.signal)
    controller.abort()
    expect(call.abortError()).toMatchObject({ kind: 'aborted' })
    call.dispose()
  })

  it('leaves no timer or listener behind after dispose', () => {
    const before = timers()
    const controller = new AbortController()
    startCall(5000, controller.signal).dispose()
    expect(timers()).toBeLessThanOrEqual(before)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('postJson', () => {
  it('posts the body as JSON with the given headers and returns the parsed reply', async () => {
    const transport = createFakeTransport()
    transport.script(jsonReply({ ok: true }, 200, { 'x-request-id': 'r1' }))
    const { base, call } = request(transport)
    const reply = await postJson(base)
    call.dispose()
    expect(reply.body).toEqual({ ok: true })
    expect(reply.status).toBe(200)
    expect(reply.headers.get('x-request-id')).toBe('r1')
    expect(transport.requests[0]).toMatchObject({ url: 'https://vendor.test/v1/x', method: 'POST', json: { hello: 'world' } })
    expect(transport.requests[0]?.headers['content-type']).toBe('application/json')
    expect(transport.requests[0]?.headers.authorization).toBe(`Bearer ${transport.apiKey}`)
  })

  it('classifies an error status and never echoes the key', async () => {
    const transport = createFakeTransport()
    transport.script(errorReply(401, { error: { message: `bad key ${transport.apiKey}` } }))
    const { base, call } = request(transport)
    const error = await fails(postJson(base))
    call.dispose()
    expect(error).toMatchObject({ kind: 'auth', status: 401 })
    expect(error.message).not.toContain(transport.apiKey)
  })

  it('uses a vendor classifier when one is given', async () => {
    const transport = createFakeTransport()
    transport.script(errorReply(400, { error: 'x' }))
    const { base, call } = request(transport)
    const error = await fails(postJson({ ...base, classify: (status) => new LlmError('refusal', `custom ${status}`) }))
    call.dispose()
    expect(error).toMatchObject({ kind: 'refusal', message: 'custom 400' })
  })

  it('reports an unparseable success body as invalid output without quoting it', async () => {
    const transport = createFakeTransport()
    transport.script({ kind: 'text', body: `<html>${transport.apiKey}</html>` })
    const { base, call } = request(transport)
    const error = await fails(postJson(base))
    call.dispose()
    expect(error).toMatchObject({ kind: 'invalid_output' })
    expect(error.message).not.toContain('<html>')
  })

  it('maps a network failure to a connection error that keeps its cause', async () => {
    const transport = createFakeTransport()
    transport.script({ kind: 'network-error' })
    const { base, call } = request(transport)
    const error = await fails(postJson(base))
    call.dispose()
    expect(error).toMatchObject({ kind: 'connection' })
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('sends nothing when the caller already aborted', async () => {
    const transport = createFakeTransport()
    transport.script(jsonReply({}))
    const controller = new AbortController()
    controller.abort()
    const { base, call } = request(transport, 5000, controller.signal)
    await expect(postJson(base)).rejects.toMatchObject({ kind: 'aborted' })
    call.dispose()
    expect(transport.requests).toHaveLength(0)
  })

  it('turns an abort while waiting into aborted and a deadline into timeout', async () => {
    const transport = createFakeTransport()
    transport.script({ kind: 'hang' })
    const controller = new AbortController()
    const first = request(transport, 5000, controller.signal)
    const pending = postJson(first.base)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
    first.call.dispose()
    const second = request(transport, 30)
    await expect(postJson(second.base)).rejects.toMatchObject({ kind: 'timeout' })
    second.call.dispose()
  })
})

describe('postStream', () => {
  it('yields the events, reports the first one and ends cleanly', async () => {
    const transport = createFakeTransport()
    transport.script(sseReply(events))
    const { base, call } = request(transport)
    let firsts = 0
    const stream = await postStream(base, { onFirstEvent: () => void (firsts += 1) })
    expect(await drain(stream.events)).toEqual([{ data: '{"n":1}' }, { event: 'done', data: '{"n":2}' }])
    call.dispose()
    expect(firsts).toBe(1)
    expect(transport.openBodies()).toBe(0)
    expect(transport.requests[0]?.headers.accept).toContain('text/event-stream')
  })

  it('classifies an error status before any event', async () => {
    const transport = createFakeTransport()
    transport.script(errorReply(429, { error: { message: 'slow' } }, { 'retry-after': '2' }))
    const { base, call } = request(transport)
    const error = await fails(postStream(base))
    call.dispose()
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterMs: 2000 })
  })

  it('rejects a JSON body that answers a streaming request', async () => {
    const transport = createFakeTransport()
    transport.script(jsonReply({ not: 'a stream' }))
    const { base, call } = request(transport)
    const error = await fails(postStream(base))
    call.dispose()
    expect(error).toMatchObject({ kind: 'invalid_output' })
    expect(transport.openBodies()).toBe(0)
  })

  it('maps a dropped stream to connection and leaves no body open', async () => {
    const transport = createFakeTransport()
    transport.script(sseReply(events.slice(0, 1), 'drop'))
    const { base, call } = request(transport)
    const stream = await postStream(base)
    const seen: SseEvent[] = []
    const error = await (async () => {
      for await (const event of stream.events) seen.push(event)
    })().catch((e: unknown) => e as LlmError)
    call.dispose()
    expect(seen).toHaveLength(1)
    expect(error).toMatchObject({ kind: 'connection' })
    expect(transport.openBodies()).toBe(0)
  })

  it('maps an abort while the stream is held to aborted, then a deadline to timeout', async () => {
    const transport = createFakeTransport()
    transport.script(sseReply(events.slice(0, 1), 'hold'))
    const controller = new AbortController()
    const first = request(transport, 5000, controller.signal)
    const stream = await postStream(first.base)
    const run = drain(stream.events)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(run).rejects.toMatchObject({ kind: 'aborted' })
    first.call.dispose()
    expect(transport.openBodies()).toBe(0)
    const second = request(transport, 40)
    await expect(drain((await postStream(second.base)).events)).rejects.toMatchObject({ kind: 'timeout' })
    second.call.dispose()
    expect(transport.openBodies()).toBe(0)
  })

  it('cancels the body on close when nobody read it', async () => {
    const transport = createFakeTransport()
    transport.script(sseReply(events, 'hold'))
    const { base, call } = request(transport)
    const stream = await postStream(base)
    await stream.close()
    call.dispose()
    expect(transport.openBodies()).toBe(0)
  })

  it('stops reading and releases the body when the consumer breaks early', async () => {
    const transport = createFakeTransport()
    transport.script(sseReply(events, 'hold'))
    const { base, call } = request(transport)
    const stream = await postStream(base)
    for await (const event of stream.events) {
      void event
      break
    }
    call.dispose()
    expect(transport.openBodies()).toBe(0)
  })
})
