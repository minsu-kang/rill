// @vitest-environment node
import { EXPLAIN_LIKELY_CAUSES, EXPLAIN_SIGNALS, ExplainResultSchema, METHODS, RillError, type ExplainResult } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withExplainMethod } from '../src/engine/fake-explain'
import { explainCases, EXPLAIN_RUN_ID } from '../src/fixtures/explain'
import { fakeData } from '../src/fixtures'

const cases = Object.entries(explainCases) as Array<[string, ExplainResult]>

describe('explain fixtures', () => {
  it('all pass the protocol result schema', () => {
    for (const [name, result] of cases) expect(Value.Check(ExplainResultSchema, result), name).toBe(true)
  })

  it('cover every likely cause', () => {
    expect(new Set(cases.map(([, result]) => result.likelyCause))).toEqual(new Set(EXPLAIN_LIKELY_CAUSES))
  })

  it('cover zero, one and three actions, with and without a fix proposal', () => {
    const counts = new Set(cases.map(([, result]) => result.suggestedActions.length))
    expect([...counts]).toEqual(expect.arrayContaining([0, 1, 3]))
    expect(cases.some(([, result]) => result.fixProposal !== undefined)).toBe(true)
    expect(cases.some(([, result]) => result.fixProposal === undefined)).toBe(true)
  })

  it('cover hidden markers, truncated and repaired answers, an unknown cost and a lowered effort', () => {
    expect(cases.some(([, r]) => r.explanation.includes('<hidden>') && r.fixProposal?.requestText.includes('<hidden>'))).toBe(true)
    expect(cases.some(([, r]) => r.meta.truncated)).toBe(true)
    expect(cases.some(([, r]) => r.meta.repaired)).toBe(true)
    expect(cases.some(([, r]) => r.meta.costUsd === null)).toBe(true)
    expect(cases.some(([, r]) => r.meta.effort.requested !== r.meta.effort.effective)).toBe(true)
  })

  it('cover every signal, the longest explanation and hostile text', () => {
    const signals = new Set(cases.flatMap(([, result]) => result.signals.map((entry) => entry.signal)))
    expect(signals).toEqual(new Set(EXPLAIN_SIGNALS))
    expect(explainCases.longExplanation.explanation).toHaveLength(1_500)
    expect(explainCases.hostile.explanation).toContain('<img')
    expect(explainCases.hostile.explanation).toContain('<script>')
  })
})

describe('withExplainMethod', () => {
  const base = createFakeClient(fakeData)

  it('answers explainRun from the script and passes every other method to the client', async () => {
    const script = vi.fn(() => explainCases.credentials)
    const client = withExplainMethod(base, script)
    const answer = await client.request('explainRun', { runId: EXPLAIN_RUN_ID, effort: 'low' })
    expect(answer).toEqual(explainCases.credentials)
    expect(script).toHaveBeenCalledWith({ runId: EXPLAIN_RUN_ID, effort: 'low' })
    expect((await client.request('listWorkflows', {})).workflows.length).toBeGreaterThan(0)
  })

  it('hands out a copy, so a caller cannot change the fixture', async () => {
    const client = withExplainMethod(base, () => explainCases.credentials)
    const answer = await client.request('explainRun', { runId: EXPLAIN_RUN_ID })
    answer.explanation = 'changed'
    expect(explainCases.credentials.explanation).not.toBe('changed')
  })

  it('rejects params that the real schema rejects', async () => {
    const script = vi.fn(() => explainCases.credentials)
    const client = withExplainMethod(base, script)
    const rejections = [
      { runId: EXPLAIN_RUN_ID, effort: 'xhigh' },
      { runId: EXPLAIN_RUN_ID, extra: 1 },
      { runId: '' },
      {},
    ]
    for (const params of rejections) {
      await expect(client.request('explainRun', params as never)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    expect(script).not.toHaveBeenCalled()
    expect(Value.Check(METHODS.explainRun.params, { runId: 'x', effort: 'high' })).toBe(true)
  })

  it('throws the error the script returns', async () => {
    const client = withExplainMethod(base, () => new RillError('EXPLAIN_BUSY', 'busy'))
    await expect(client.request('explainRun', { runId: EXPLAIN_RUN_ID })).rejects.toMatchObject({ code: 'EXPLAIN_BUSY' })
  })

  it('never answers on a hang', async () => {
    const client = withExplainMethod(base, () => 'hang')
    const winner = await Promise.race([client.request('explainRun', { runId: EXPLAIN_RUN_ID }).then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 30))])
    expect(winner).toBe('waiting')
  })

  it('refuses an answer that does not match the protocol', async () => {
    const client = withExplainMethod(base, () => ({ ...explainCases.credentials, explanation: '' }))
    await expect(client.request('explainRun', { runId: EXPLAIN_RUN_ID })).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('passes the events of the client on', () => {
    const received: string[] = []
    const client = withExplainMethod(base, () => explainCases.credentials)
    const off = client.onEvent((event) => received.push(event.type))
    base.emit({ type: 'trigger.fired', runId: 'r', workflowId: 'w', at: 1 } as never)
    off()
    expect(received).toEqual(['trigger.fired'])
  })
})
