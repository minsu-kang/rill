import { describe, expect, it } from 'vitest'
import { createFakeTransport, jsonReply } from '../../llm/test/fake-transport'
import { responseBody } from '../../llm/test/openai-wire'
import { main, type CliIo } from '../src/cli'
import { PREFIX_TOKENS } from '../src/check-provider'
import { estimateWorstCallUsd } from '../src/pricing'

const SPEC = 'openai:gpt-6-astra'
const FIRST_CALL_TOKENS = PREFIX_TOKENS + 40

function run(args: string[], replies: ReturnType<typeof jsonReply>[] = []) {
  const transport = createFakeTransport()
  transport.script(...replies)
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    env: { OPENAI_API_KEY: 'sk-openai-X-123456' },
    now: () => Date.UTC(2026, 10, 13),
    checkProvider: { fetch: transport.fetch },
  }
  return main(['check-provider', '--provider', 'openai', '--model', 'gpt-6-astra', ...args], io).then((code) => ({ code, transport, out: out.join(''), err: err.join('') }))
}

const writing = (output: number) => {
  const usage = {
    input_tokens: FIRST_CALL_TOKENS,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: PREFIX_TOKENS },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: output - 10 },
    total_tokens: FIRST_CALL_TOKENS + output,
  }
  return jsonReply(responseBody('completed', '{"word":"rill","count":3,"note":null}', { model: 'gpt-6-astra', usage }))
}

describe('check-provider budget guard at the boundary', () => {
  it('runs the first call when the budget is exactly its worst case', async () => {
    const worst = estimateWorstCallUsd(SPEC, FIRST_CALL_TOKENS, 2000)!
    const { code, out, transport } = await run(['--budget-usd', String(worst), '--yes'], [writing(100), writing(100)])
    expect(code).toBe(0)
    expect(transport.requests).toHaveLength(1)
    expect(out).toContain('call 1 of 4: text + schema with an optional field: ok')
    expect(out).toContain('call 2 of 4: the same call again, to see a cache read: not run')
  })

  it('refuses a budget one cent below the first worst case before sending anything', async () => {
    const worst = estimateWorstCallUsd(SPEC, FIRST_CALL_TOKENS, 2000)!
    const { code, err, transport } = await run(['--budget-usd', String(worst - 0.01), '--yes'], [writing(100)])
    expect(code).not.toBe(0)
    expect(err).toContain('below the worst case of the first call')
    expect(transport.requests).toHaveLength(0)
  })

  it('reserves twice the output for a model whose reasoning the cap does not cover', async () => {
    const soft = estimateWorstCallUsd('grok:grok-4.7', FIRST_CALL_TOKENS, 2000 * 2)!
    const plain = estimateWorstCallUsd('grok:grok-4.7', FIRST_CALL_TOKENS, 2000)!
    expect(soft).toBeGreaterThan(plain)
    const out: string[] = []
    const io: CliIo = { stdout: (text) => void out.push(text), stderr: () => undefined, env: { XAI_API_KEY: 'xai-12345678' }, now: () => Date.UTC(2026, 10, 13) }
    await main(['check-provider', '--provider', 'grok', '--model', 'grok-4.7', '--dry'], io)
    expect(out.join('')).toContain('worst case $' + soft.toFixed(4))
    expect(out.join('')).not.toContain('worst case $' + plain.toFixed(4))
  })
})

describe('check-provider budget guard', () => {
  const worstFirst = estimateWorstCallUsd(SPEC, FIRST_CALL_TOKENS, 2000)!

  it('reserves the cache-marked prefix at the cache write rate, since the first call is built to write it', async () => {
    const plain = (FIRST_CALL_TOKENS * 10 + 2000 * 50) / 1e6
    expect(worstFirst).toBeGreaterThan(plain)
    const { code, err } = await run(['--budget-usd', String(plain), '--yes'])
    expect(code).not.toBe(0)
    expect(err).toContain('below the worst case of the first call')
  })

  it('never spends more than --budget-usd when the first call writes the cache and uses its whole output cap', async () => {
    const budget = Math.ceil(worstFirst * 10_000) / 10_000
    const { out, transport } = await run(['--budget-usd', String(budget), '--yes'], [writing(2000), writing(2000), writing(2000), writing(2000)])
    const spent = Number(/spent \$([\d.]+)/u.exec(out)?.[1])
    expect(transport.requests.length).toBeGreaterThan(0)
    expect(spent).toBeLessThanOrEqual(budget)
  })

  it('shows the same worst case in --dry, so what is printed is what the guard enforces', async () => {
    const { out } = await run(['--dry'])
    expect(out).toContain(`worst case $${worstFirst.toFixed(4)}`)
  })
})
