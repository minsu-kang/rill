import { strictify } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { LIKELY_CAUSES, SUGGESTED_ACTIONS, checkAnswer, explainSchema } from '../../src/index'

const valid = { explanation: 'The service refused the key.', likelyCause: 'credentials_or_connection', suggestedActions: ['open_connections'] }

const problems = (data: unknown): string[] => checkAnswer(data).problems

describe('the lists', () => {
  it('are fixed', () => {
    expect([...LIKELY_CAUSES]).toEqual(['configuration', 'input_data', 'external_service', 'credentials_or_connection', 'permission_or_path', 'rate_limit_or_timeout', 'workflow_design', 'unknown'])
    expect([...SUGGESTED_ACTIONS]).toEqual(['retry_run', 'open_connections', 'edit_node', 'check_input_file', 'wait_and_retry', 'deactivate_workflow', 'none'])
  })
})

describe('checkAnswer', () => {
  it('accepts a minimal answer, one with a fix proposal and one with a null fix proposal', () => {
    expect(checkAnswer(valid)).toEqual({ answer: valid, problems: [] })
    const withFix = { ...valid, fixProposal: { nodeId: 'n1', requestText: 'Use the connection billing for this call' } }
    expect(checkAnswer(withFix)).toEqual({ answer: withFix, problems: [] })
    expect(checkAnswer({ ...valid, fixProposal: null })).toEqual({ answer: valid, problems: [] })
  })

  it('accepts no actions, three actions, and every cause', () => {
    expect(problems({ ...valid, suggestedActions: [] })).toEqual([])
    expect(problems({ ...valid, suggestedActions: ['retry_run', 'edit_node', 'none'] })).toEqual([])
    for (const cause of LIKELY_CAUSES) expect(problems({ ...valid, likelyCause: cause })).toEqual([])
  })

  it('trims the text it keeps', () => {
    const answer = checkAnswer({ ...valid, explanation: '  spaced  ', fixProposal: { nodeId: 'n1', requestText: '\n change it \n' } }).answer!
    expect(answer.explanation).toBe('spaced')
    expect(answer.fixProposal?.requestText).toBe('change it')
  })

  it('counts characters, not UTF-16 units', () => {
    expect(problems({ ...valid, explanation: '😀'.repeat(1500) })).toEqual([])
    expect(problems({ ...valid, explanation: '😀'.repeat(1501) })).not.toEqual([])
    expect(problems({ ...valid, fixProposal: { nodeId: 'n1', requestText: '😀'.repeat(400) } })).toEqual([])
    expect(problems({ ...valid, fixProposal: { nodeId: 'n1', requestText: '😀'.repeat(401) } })).not.toEqual([])
  })

  const BAD: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'text'],
    ['an array', [valid]],
    ['an extra key', { ...valid, extra: 1 }],
    ['a missing explanation', { likelyCause: 'unknown', suggestedActions: [] }],
    ['an empty explanation', { ...valid, explanation: '' }],
    ['a blank explanation', { ...valid, explanation: '   \n ' }],
    ['an explanation that is not a string', { ...valid, explanation: 5 }],
    ['an explanation over 1500 characters', { ...valid, explanation: 'x'.repeat(1501) }],
    ['a missing cause', { explanation: 'x', suggestedActions: [] }],
    ['an unknown cause', { ...valid, likelyCause: 'bad_luck' }],
    ['a missing actions list', { explanation: 'x', likelyCause: 'unknown' }],
    ['actions that are not a list', { ...valid, suggestedActions: 'retry_run' }],
    ['an unknown action', { ...valid, suggestedActions: ['reboot'] }],
    ['a repeated action', { ...valid, suggestedActions: ['retry_run', 'retry_run'] }],
    ['four actions', { ...valid, suggestedActions: ['retry_run', 'open_connections', 'edit_node', 'none'] }],
    ['an action that is not a string', { ...valid, suggestedActions: [1] }],
    ['a fix proposal that is not an object', { ...valid, fixProposal: 'n1' }],
    ['a fix proposal that is a list', { ...valid, fixProposal: [] }],
    ['a fix proposal without a node', { ...valid, fixProposal: { requestText: 'x' } }],
    ['a fix proposal with an empty node', { ...valid, fixProposal: { nodeId: '', requestText: 'x' } }],
    ['a fix proposal without text', { ...valid, fixProposal: { nodeId: 'n1' } }],
    ['a fix proposal with empty text', { ...valid, fixProposal: { nodeId: 'n1', requestText: '' } }],
    ['a fix proposal with text over 400 characters', { ...valid, fixProposal: { nodeId: 'n1', requestText: 'x'.repeat(401) } }],
    ['a fix proposal with an extra key', { ...valid, fixProposal: { nodeId: 'n1', requestText: 'x', extra: true } }],
  ]

  it.each(BAD)('rejects %s', (_name, data) => {
    const result = checkAnswer(data)
    expect(result.answer).toBeUndefined()
    expect(result.problems.length).toBeGreaterThan(0)
  })

  it('names the broken rules in fixed words that never repeat the answer', () => {
    const MARK = 'INJECTED-MARKER-77'
    const result = checkAnswer({ explanation: 5, likelyCause: MARK, suggestedActions: [MARK, MARK], [MARK]: MARK, fixProposal: { nodeId: MARK, requestText: 'x'.repeat(500), [MARK]: 1 } })
    expect(result.problems.length).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(result.problems)).not.toContain(MARK)
    expect(new Set(result.problems).size).toBe(result.problems.length)
    expect(result.problems.join('\n')).toContain('likelyCause must be one of: configuration, input_data')
  })
})

describe('explainSchema', () => {
  const schema = explainSchema() as { type: string; properties: Record<string, { type?: string; enum?: string[]; items?: { enum?: string[] }; properties?: object; required?: string[] }>; required: string[]; additionalProperties: boolean }

  it('is a closed object with the cause and the actions as enums', () => {
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual(['explanation', 'likelyCause', 'suggestedActions', 'fixProposal'])
    expect(schema.required).toEqual(['explanation', 'likelyCause', 'suggestedActions'])
    expect(schema.properties['likelyCause']?.enum).toEqual([...LIKELY_CAUSES])
    expect(schema.properties['suggestedActions']?.items?.enum).toEqual([...SUGGESTED_ACTIONS])
    expect(schema.properties['fixProposal']?.required).toEqual(['nodeId', 'requestText'])
  })

  it('has no keyword that a provider in strict mode refuses', () => {
    const text = JSON.stringify(schema)
    for (const keyword of ['minLength', 'maxLength', 'maxItems', 'minItems', 'uniqueItems', 'pattern', 'format']) expect(text).not.toContain(`"${keyword}"`)
  })

  it('turns into a strict schema and answers that restore to the same data', () => {
    const strict = strictify(explainSchema())
    expect(strict.schema).toMatchObject({ additionalProperties: false })
    const sent = JSON.parse(JSON.stringify(strict.schema)) as { required: string[] }
    expect(sent.required).toEqual(['explanation', 'likelyCause', 'suggestedActions', 'fixProposal'])
    expect(strict.restore({ ...valid, fixProposal: null })).toEqual(valid)
  })

  it('returns a fresh copy each time', () => {
    const first = explainSchema() as { required: string[] }
    first.required.push('x')
    expect((explainSchema() as { required: string[] }).required).toEqual(['explanation', 'likelyCause', 'suggestedActions'])
  })
})
