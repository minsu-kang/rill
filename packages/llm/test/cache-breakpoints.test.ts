import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CACHE_BREAKPOINTS, type LlmMessage, type LlmPart, type LlmRequest } from '../src/index'
import { closeServers, message, mock, provider, request, schema } from './mock'

afterEach(closeServers)

const EPHEMERAL = { type: 'ephemeral' }
const ok = () => ({ body: message('{"a":1}') })

async function sentBody(overrides: Partial<LlmRequest>): Promise<Record<string, unknown>> {
  const { seen, baseURL } = await mock(ok)
  await provider(baseURL).generate({ ...request, ...overrides })
  expect(seen).toHaveLength(1)
  return seen[0]!.body
}

describe('system blocks', () => {
  it('maps blocks to text blocks with cache_control only where marked', async () => {
    const body = await sentBody({
      system: [{ text: 'rules' }, { text: 'catalog', cache: true }, { text: 'tail', cache: false }],
    })
    expect(body.system).toEqual([
      { type: 'text', text: 'rules' },
      { type: 'text', text: 'catalog', cache_control: EPHEMERAL },
      { type: 'text', text: 'tail' },
    ])
  })

  it('keeps a string system prompt a plain string and sends nothing for a missing or empty block list', async () => {
    expect((await sentBody({ system: 'be exact' })).system).toBe('be exact')
    expect(await sentBody({ system: '' })).toHaveProperty('system', '')
    expect(await sentBody({ system: [] })).not.toHaveProperty('system')
    expect(await sentBody({})).not.toHaveProperty('system')
  })

  it('leaves the top-level cache flag alone when blocks carry breakpoints too', async () => {
    const body = await sentBody({ system: [{ text: 'catalog', cache: true }], cache: true })
    expect(body).toMatchObject({ cache_control: EPHEMERAL, system: [{ type: 'text', text: 'catalog', cache_control: EPHEMERAL }] })
    expect(await sentBody({ system: [{ text: 'catalog', cache: true }] })).not.toHaveProperty('cache_control')
  })

  it('does not treat a truthy non-boolean flag as a breakpoint', async () => {
    const body = await sentBody({ system: [{ text: 'x', cache: 'yes' as unknown as boolean }] })
    expect(body.system).toEqual([{ type: 'text', text: 'x' }])
  })
})

describe('content part breakpoints', () => {
  const parts: LlmPart[] = [
    { type: 'document', mediaType: 'application/pdf', data: 'UERG', cache: true },
    { type: 'image', mediaType: 'image/png', data: 'UE5H', cache: true },
    { type: 'text', text: 'cached note', cache: true },
    { type: 'document', mediaType: 'application/pdf', data: 'UERG2', cache: false },
    { type: 'image', mediaType: 'image/jpeg', data: 'SlBH' },
    { type: 'text', text: 'plain note' },
  ]

  it('maps the flag to cache_control on text, document and image blocks', async () => {
    const body = await sentBody({ messages: [{ role: 'user', content: parts.slice(0, 3) }] })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' }, cache_control: EPHEMERAL },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' }, cache_control: EPHEMERAL },
          { type: 'text', text: 'cached note', cache_control: EPHEMERAL },
        ],
      },
    ])
  })

  it('sends no cache_control on parts that are unflagged or flagged false', async () => {
    const body = await sentBody({ messages: [{ role: 'user', content: parts.slice(3) }] })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG2' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'SlBH' } },
          { type: 'text', text: 'plain note' },
        ],
      },
    ])
  })
})

describe('breakpoint limit', () => {
  const part = (cache: boolean): LlmPart => ({ type: 'text', text: 't', cache })
  const block = (cache: boolean) => ({ text: 's', cache })
  const user = (...content: LlmPart[]): LlmMessage => ({ role: 'user', content })

  it('allows exactly four breakpoints from any mix of sources', async () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4)
    const mixes: Partial<LlmRequest>[] = [
      { messages: [user(part(true), part(true), part(true), part(true))] },
      { system: [block(true), block(true), block(true), block(true)] },
      { system: [block(true), block(true)], messages: [user(part(true), part(true))] },
      { cache: true, system: [block(true)], messages: [user(part(true), part(true))] },
      { cache: true, messages: [user(part(true)), { role: 'assistant', content: 'x' }, user(part(true), part(true))] },
    ]
    for (const mix of mixes) {
      const { seen, baseURL } = await mock(ok)
      await provider(baseURL).generate({ ...request, ...mix })
      expect(seen).toHaveLength(1)
    }
  })

  it.each<[string, Partial<LlmRequest>, number]>([
    ['five parts', { messages: [user(part(true), part(true), part(true), part(true), part(true))] }, 5],
    ['five system blocks', { system: [block(true), block(true), block(true), block(true), block(true)] }, 5],
    ['the top-level flag plus four parts', { cache: true, messages: [user(part(true), part(true), part(true), part(true))] }, 5],
    ['the top-level flag plus four system blocks', { cache: true, system: [block(true), block(true), block(true), block(true)] }, 5],
    ['system blocks plus parts', { system: [block(true), block(true), block(true)], messages: [user(part(true), part(true))] }, 5],
    [
      'parts spread over several turns',
      {
        messages: [
          user(part(true), part(true)),
          { role: 'assistant', content: '{"a":0}' },
          user(part(true), part(true)),
          { role: 'assistant', content: '{"a":1}' },
          user(part(true)),
        ],
      },
      5,
    ],
  ])('rejects %s before any network call', async (_name, overrides, count) => {
    const { seen, baseURL } = await mock(ok)
    const error = await provider(baseURL).generate({ ...request, ...overrides }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'invalid_request', retryable: false, name: 'LlmError' })
    expect((error as Error).message).toContain(`got ${count}`)
    expect(seen).toHaveLength(0)
  })

  it('does not count flags that are false or missing', async () => {
    const { seen, baseURL } = await mock(ok)
    await provider(baseURL).generate({
      ...request,
      cache: false,
      system: [block(false), block(false), block(true)],
      messages: [user(part(false), part(false), part(true), { type: 'text', text: 'u' }, part(true), part(true))],
    })
    expect(seen).toHaveLength(1)
  })

  it('counts nothing for string content', async () => {
    const { seen, baseURL } = await mock(ok)
    await provider(baseURL).generate({ ...request, cache: true, system: [block(true), block(true), block(true)] })
    expect(seen).toHaveLength(1)
  })
})

describe('multi-turn conversations', () => {
  const turns: LlmMessage[] = [
    { role: 'user', content: 'plan a receipt workflow' },
    { role: 'assistant', content: '{"kind":"questions","summary":"which folder?"}' },
    { role: 'user', content: [{ type: 'text', text: 'the receipts folder' }, { type: 'document', mediaType: 'application/pdf', data: 'UERG', cache: true }] },
    { role: 'assistant', content: '{"kind":"workflow","summary":"done"}' },
    { role: 'user', content: [{ type: 'text', text: 'also email me', cache: true }] },
  ]

  it('maps alternating user and assistant turns one to one, in order', async () => {
    const body = await sentBody({ messages: turns })
    expect(body.messages).toEqual([
      { role: 'user', content: 'plan a receipt workflow' },
      { role: 'assistant', content: '{"kind":"questions","summary":"which folder?"}' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'the receipts folder' },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' }, cache_control: EPHEMERAL },
        ],
      },
      { role: 'assistant', content: '{"kind":"workflow","summary":"done"}' },
      { role: 'user', content: [{ type: 'text', text: 'also email me', cache_control: EPHEMERAL }] },
    ])
  })

  it('sends the previous structured result as the exact JSON text of the assistant turn', async () => {
    const previous = { kind: 'workflow', summary: 'two nodes', workflow: { name: 'x', nodes: [{ id: 'a', type: 'trigger.manual', config: '{}' }] } }
    const body = await sentBody({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: JSON.stringify(previous) },
        { role: 'user', content: 'change it' },
      ],
    })
    const sent = body.messages as { role: string; content: string }[]
    expect(JSON.parse(sent[1]!.content)).toEqual(previous)
    expect(sent[1]!.content).toBe(JSON.stringify(previous))
  })

  it('keeps the last-message-must-be-user guard for conversations with breakpoints', async () => {
    const { seen, baseURL } = await mock(ok)
    const ending = [...turns, { role: 'assistant', content: '{"kind":"workflow"}' } as const]
    await expect(provider(baseURL).generate({ schema, messages: ending, system: [{ text: 's', cache: true }] })).rejects.toMatchObject({
      kind: 'invalid_request',
    })
    await expect(provider(baseURL).generate({ schema, messages: turns.slice(0, 2), cache: true })).rejects.toMatchObject({
      kind: 'invalid_request',
    })
    expect(seen).toHaveLength(0)
  })

  it('applies the breakpoint limit to a whole conversation', async () => {
    const { seen, baseURL } = await mock(ok)
    const cached = (text: string): LlmMessage => ({ role: 'user', content: [{ type: 'text', text, cache: true }] })
    const reply: LlmMessage = { role: 'assistant', content: '{}' }
    const messages = [cached('1'), reply, cached('2'), reply, cached('3'), reply, cached('4'), reply, cached('5')]
    await expect(provider(baseURL).generate({ schema, messages })).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(provider(baseURL).generate({ schema, messages: messages.slice(2) })).resolves.toMatchObject({ data: { a: 1 } })
    expect(seen).toHaveLength(1)
  })
})
