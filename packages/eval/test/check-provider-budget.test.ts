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
