import { LlmError, type LlmProvider } from '@rill/llm'
import { NodeRegistry } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { ANSWER_PROBLEMS, checkAnswer, createExplainer, explainSchema, failureSignals, userText } from '../../src/index'
import { FakeProvider } from '../fake-provider'
import { chain, edge, inputOf, node, registry, runOf, step, workflowOf } from './helpers'

const valid = { explanation: 'x', likelyCause: 'unknown', suggestedActions: [] }
const GOOD = { explanation: 'The orders service rejected the credentials of node n1.', likelyCause: 'credentials_or_connection', suggestedActions: ['open_connections'] }

describe('the node id of a fix proposal', () => {
  it('takes 64 characters, and refuses 65 and none', () => {
    expect(checkAnswer({ ...valid, fixProposal: { nodeId: 'n'.repeat(64), requestText: 'x' } }).problems).toEqual([])
    expect(checkAnswer({ ...valid, fixProposal: { nodeId: 'n'.repeat(65), requestText: 'x' } }).problems).toEqual([ANSWER_PROBLEMS.proposalNode])
    expect(checkAnswer({ ...valid, fixProposal: { nodeId: '', requestText: 'x' } }).problems).toEqual([ANSWER_PROBLEMS.proposalNode])
  })
})

describe('the text of an answer', () => {
  it('is cleaned of invisible characters before it is counted and kept', () => {
    expect(checkAnswer({ ...valid, explanation: 'a\u200bb' }).answer?.explanation).toBe('ab')
    expect(checkAnswer({ ...valid, explanation: '\u200b\u200b' }).problems).toEqual([ANSWER_PROBLEMS.explanation])
  })

  it('is refused when the raw text is more than twice the limit, even if most of it is invisible', () => {
    expect(checkAnswer({ ...valid, explanation: `ok${'\u200b'.repeat(2998)}` }).answer?.explanation).toBe('ok')
    expect(checkAnswer({ ...valid, explanation: `ok${'\u200b'.repeat(2999)}` }).problems).toEqual([ANSWER_PROBLEMS.explanation])
    expect(checkAnswer({ ...valid, fixProposal: { nodeId: 'n1', requestText: `ok${'\u200b'.repeat(798)}` } }).answer?.fixProposal?.requestText).toBe('ok')
    expect(checkAnswer({ ...valid, fixProposal: { nodeId: 'n1', requestText: `ok${'\u200b'.repeat(799)}` } }).problems).toEqual([ANSWER_PROBLEMS.proposalText])
  })
})

describe('the schema that the model gets', () => {
  it('closes the fix proposal as well', () => {
    const schema = explainSchema() as { properties: { fixProposal: { additionalProperties?: boolean } } }
    expect(schema.properties.fixProposal.additionalProperties).toBe(false)
  })
})

describe('the random tag', () => {
  it.each(['abcdef0123456', 'abcdef01234', 'ABCDEF012345', 'abcdef01234g', ' abcdef012345', 'abcdef012345\n', ''])('refuses %j from the random source', async (hex) => {
    const provider = new FakeProvider([{ data: GOOD }])
    const ex = createExplainer({ provider, registry, randomHex: () => hex })
    await expect(ex.explain(inputOf())).rejects.toThrow('randomHex must return 12 lowercase hex characters')
    expect(provider.calls).toHaveLength(0)
  })

  it('asks the random source for 6 bytes', async () => {
    const asked: number[] = []
    const provider = new FakeProvider([{ data: GOOD }])
    await createExplainer({ provider, registry, randomHex: (bytes) => (asked.push(bytes), 'abcdef012345') }).explain(inputOf())
    expect(asked).toEqual([6])
  })

  it('makes a tag that starts with run-data-', async () => {
    const provider = new FakeProvider([{ data: GOOD }])
    await createExplainer({ provider, registry, randomHex: () => '0123456789ab' }).explain(inputOf())
    const content = provider.calls[0]!.request.messages[0]!.content
    expect(typeof content === 'string' ? content : '').toContain('<run-data-0123456789ab>')
  })
})

describe('the node ids that are named outside the tag', () => {
  const lines = (id: string): string => userText('run-data-abcdef012345', [{ nodeId: id, signal: 'timeout' }], 'D').split('\n')[1]!

  it.each(['a', 'n1', 'node_1', `a${'b'.repeat(31)}`])('names %s', (id) => {
    expect(lines(id)).toBe(`- ${id}: timeout`)
  })

  it.each(['A1', 'N1', '1a', '_a', 'a-b', 'a.b', 'a b', `a${'b'.repeat(32)}`, '', 'a\nb', 'é1'])('does not name %j, which could carry text of the run', (id) => {
    expect(lines(id)).toBe('- a node: timeout')
  })

  it('refuses an id that only ends right', () => {
    expect(lines('x\ny1')).toBe('- a node: timeout')
    expect(lines('Aa1\nb1')).toBe('- a node: timeout')
  })
})

describe('effort that is not a level of its own', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('refuses %s', async (effort) => {
    const provider = new FakeProvider([{ data: GOOD }])
    await expect(createExplainer({ provider, registry }).explain({ ...inputOf(), effort: effort as never })).rejects.toThrow(RangeError)
    expect(provider.calls).toHaveLength(0)
  })
})

describe('an abort that the provider reports as another error', () => {
  it('is reported as aborted when the signal fired', async () => {
    const controller = new AbortController()
    const provider: LlmProvider = {
      name: 'odd',
      generate: () => {
        controller.abort()
        return Promise.reject(new TypeError('socket hang up'))
      },
    }
    const error = await createExplainer({ provider, registry }).explain({ ...inputOf(), signal: controller.signal }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: 'ExplainError', kind: 'aborted' })
  })

  it('is reported as a provider error when the signal did not fire', async () => {
    const provider: LlmProvider = { name: 'odd', generate: () => Promise.reject(new TypeError('socket hang up')) }
    const error = await createExplainer({ provider, registry }).explain({ ...inputOf(), signal: new AbortController().signal }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ name: 'ExplainError', kind: 'provider' })
  })

  it('is reported as aborted when the provider says so itself', async () => {
    const provider = new FakeProvider([{ error: new LlmError('aborted', 'aborted') }])
    const error = await createExplainer({ provider, registry }).explain(inputOf()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'aborted' })
  })
})

describe('the explanation shows a path of the run data that the workflow does not have', () => {
  it('keeps a path that the digest shows and hides one that it does not', async () => {
    const provider = new FakeProvider([{ data: { ...GOOD, explanation: 'The file /data/inbox/receipt-17.pdf failed, not /data/inbox/other.pdf.' } }])
    const input = inputOf({ steps: [step('n1', 'failed', { error: 'HTTP 404: /data/inbox/receipt-17.pdf is gone' })], workflow: chain() })
    const result = await createExplainer({ provider, registry }).explain({ ...input, run: runOf() })
    expect(result.explanation).toBe('The file /data/inbox/receipt-17.pdf failed, not <hidden>.')
  })
})

describe('the signals of a node whose type the registry does not have', () => {
  it('stay general, even when the message fits a rule of a type that exists', () => {
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node('f1', 'file.read@1', { path: '/data/in.txt' }), node('c1', 'csv.append@1', { file: '/data/out.csv', row: ['a'] })], [edge('t1', 'f1'), edge('f1', 'c1')])
    const empty = new NodeRegistry()
    expect(failureSignals([step('f1', 'failed', { error: "ENOENT: no such file or directory, stat '/data/in.txt'" })], empty, workflow)).toEqual([{ nodeId: 'f1', signal: 'unknown' }])
    expect(failureSignals([step('f1', 'failed', { error: "ENOENT: no such file or directory, stat '/data/in.txt'" })], registry, workflow)).toEqual([{ nodeId: 'f1', signal: 'file_missing' }])
    expect(failureSignals([step('f1', 'failed', { error: 'HTTP 404: x' })], empty, workflow)).toEqual([{ nodeId: 'f1', signal: 'http_status_404' }])
  })
})
