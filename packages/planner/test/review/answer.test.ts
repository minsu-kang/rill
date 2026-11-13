import { strictify } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { REVIEW_ANSWER_PROBLEMS, REVIEW_SEVERITIES, checkReview, reviewSchema } from '../../src/index'

const valid = { summary: 'The workflow does what the request says.', findings: [{ severity: 'warning', text: 'Node n2 writes outside the usual folder.', nodeId: 'n2' }] }

const problems = (data: unknown): string[] => checkReview(data).problems

interface SchemaView {
  type: string
  additionalProperties: boolean
  required: string[]
  properties: {
    summary: { description: string }
    findings: {
      description: string
      items: {
        type: string
        additionalProperties: boolean
        required: string[]
        properties: { severity: { enum: string[] }; text: { description: string }; nodeId: { description: string } }
      }
    }
  }
}

describe('the severities', () => {
  it('are fixed, from the most to the least important', () => {
    expect([...REVIEW_SEVERITIES]).toEqual(['problem', 'warning', 'info'])
  })
})

describe('checkReview', () => {
  it('accepts an answer with findings, one without findings and a finding without a node', () => {
    expect(checkReview(valid)).toEqual({ answer: valid, problems: [] })
    const none = { summary: 'Looks right.', findings: [] }
    expect(checkReview(none)).toEqual({ answer: none, problems: [] })
    const bare = { summary: 'x', findings: [{ severity: 'info', text: 'A remark.' }] }
    expect(checkReview(bare)).toEqual({ answer: bare, problems: [] })
  })

  it('accepts every severity, and ten findings', () => {
    for (const severity of REVIEW_SEVERITIES) expect(problems({ summary: 'x', findings: [{ severity, text: 'x' }] })).toEqual([])
    expect(problems({ summary: 'x', findings: Array.from({ length: 10 }, () => ({ severity: 'info', text: 'x' })) })).toEqual([])
  })

  it('reads a null node id as no node id', () => {
    const answer = checkReview({ summary: 'x', findings: [{ severity: 'info', text: 'x', nodeId: null }] }).answer!
    expect(answer.findings).toEqual([{ severity: 'info', text: 'x' }])
    expect(Object.keys(answer.findings[0]!)).not.toContain('nodeId')
  })

  it('trims the text it keeps', () => {
    const answer = checkReview({ summary: '  spaced  ', findings: [{ severity: 'info', text: '\n a remark \n' }] }).answer!
    expect(answer.summary).toBe('spaced')
    expect(answer.findings[0]!.text).toBe('a remark')
  })

  it('counts characters, not UTF-16 units', () => {
    expect(problems({ summary: '😀'.repeat(400), findings: [] })).toEqual([])
    expect(problems({ summary: '😀'.repeat(401), findings: [] })).not.toEqual([])
    expect(problems({ summary: 'x', findings: [{ severity: 'info', text: '😀'.repeat(400) }] })).toEqual([])
    expect(problems({ summary: 'x', findings: [{ severity: 'info', text: '😀'.repeat(401) }] })).not.toEqual([])
  })

  it('removes invisible and control characters before it measures and keeps', () => {
    const answer = checkReview({ summary: 'a\u200bb\u202ec\u0007d', findings: [{ severity: 'info', text: 'x\u2028y' }] }).answer!
    expect(answer.summary).toBe('abcd')
    expect(answer.findings[0]!.text).toBe('x\ny')
    expect(problems({ summary: '\u200b\u200b', findings: [] })).toEqual([REVIEW_ANSWER_PROBLEMS.summary])
  })

  const BAD: Array<[string, unknown, string]> = [
    ['null', null, REVIEW_ANSWER_PROBLEMS.notObject],
    ['a string', 'text', REVIEW_ANSWER_PROBLEMS.notObject],
    ['an array', [valid], REVIEW_ANSWER_PROBLEMS.notObject],
    ['an extra key', { ...valid, extra: 1 }, REVIEW_ANSWER_PROBLEMS.unknownKey],
    ['a missing summary', { findings: [] }, REVIEW_ANSWER_PROBLEMS.summary],
    ['an empty summary', { ...valid, summary: '' }, REVIEW_ANSWER_PROBLEMS.summary],
    ['a blank summary', { ...valid, summary: ' \n ' }, REVIEW_ANSWER_PROBLEMS.summary],
    ['a summary that is not a string', { ...valid, summary: 5 }, REVIEW_ANSWER_PROBLEMS.summary],
    ['a summary over 400 characters', { ...valid, summary: 'x'.repeat(401) }, REVIEW_ANSWER_PROBLEMS.summary],
    ['a missing findings list', { summary: 'x' }, REVIEW_ANSWER_PROBLEMS.findings],
    ['findings that are not a list', { summary: 'x', findings: 'none' }, REVIEW_ANSWER_PROBLEMS.findings],
    ['findings that are null', { summary: 'x', findings: null }, REVIEW_ANSWER_PROBLEMS.findings],
    ['eleven findings', { summary: 'x', findings: Array.from({ length: 11 }, () => ({ severity: 'info', text: 'x' })) }, REVIEW_ANSWER_PROBLEMS.findings],
    ['a finding that is not an object', { summary: 'x', findings: ['text'] }, REVIEW_ANSWER_PROBLEMS.findings],
    ['a finding that is null', { summary: 'x', findings: [null] }, REVIEW_ANSWER_PROBLEMS.findings],
    ['a finding with an extra key', { summary: 'x', findings: [{ severity: 'info', text: 'x', extra: 1 }] }, REVIEW_ANSWER_PROBLEMS.findingKey],
    ['a finding with a fix', { summary: 'x', findings: [{ severity: 'info', text: 'x', fix: 'change n1' }] }, REVIEW_ANSWER_PROBLEMS.findingKey],
    ['a missing severity', { summary: 'x', findings: [{ text: 'x' }] }, REVIEW_ANSWER_PROBLEMS.severity],
    ['an unknown severity', { summary: 'x', findings: [{ severity: 'error', text: 'x' }] }, REVIEW_ANSWER_PROBLEMS.severity],
    ['a severity in capitals', { summary: 'x', findings: [{ severity: 'PROBLEM', text: 'x' }] }, REVIEW_ANSWER_PROBLEMS.severity],
    ['a severity that is not a string', { summary: 'x', findings: [{ severity: 1, text: 'x' }] }, REVIEW_ANSWER_PROBLEMS.severity],
    ['a missing text', { summary: 'x', findings: [{ severity: 'info' }] }, REVIEW_ANSWER_PROBLEMS.text],
    ['an empty text', { summary: 'x', findings: [{ severity: 'info', text: '' }] }, REVIEW_ANSWER_PROBLEMS.text],
    ['a text over 400 characters', { summary: 'x', findings: [{ severity: 'info', text: 'x'.repeat(401) }] }, REVIEW_ANSWER_PROBLEMS.text],
    ['a text that is not a string', { summary: 'x', findings: [{ severity: 'info', text: ['x'] }] }, REVIEW_ANSWER_PROBLEMS.text],
    ['a node id that is not a string', { summary: 'x', findings: [{ severity: 'info', text: 'x', nodeId: 5 }] }, REVIEW_ANSWER_PROBLEMS.nodeId],
    ['an empty node id', { summary: 'x', findings: [{ severity: 'info', text: 'x', nodeId: '' }] }, REVIEW_ANSWER_PROBLEMS.nodeId],
    ['a node id over 64 characters', { summary: 'x', findings: [{ severity: 'info', text: 'x', nodeId: 'n'.repeat(65) }] }, REVIEW_ANSWER_PROBLEMS.nodeId],
  ]

  it.each(BAD)('refuses %s, with a fixed sentence and no answer', (_name, data, sentence) => {
    const checked = checkReview(data)
    expect(checked.answer).toBeUndefined()
    expect(checked.problems).toContain(sentence)
  })

  it('lists every kind of problem once, whatever the number of findings that have it', () => {
    const data = { summary: '', extra: 1, findings: [{ severity: 'bad', text: '' }, { severity: 'worse', text: '' }] }
    const list = problems(data)
    expect(new Set(list).size).toBe(list.length)
    expect(list).toEqual(expect.arrayContaining([REVIEW_ANSWER_PROBLEMS.unknownKey, REVIEW_ANSWER_PROBLEMS.summary, REVIEW_ANSWER_PROBLEMS.severity, REVIEW_ANSWER_PROBLEMS.text]))
  })

  it('never puts the text of the answer into a problem', () => {
    const marker = 'MODEL-MARKER-91ab'
    const data = { summary: marker, [marker]: 1, findings: [{ severity: marker, text: marker.repeat(100), nodeId: marker.repeat(10), [marker]: 2 }] }
    expect(JSON.stringify(problems(data))).not.toContain(marker)
  })
})

describe('reviewSchema', () => {
  const schema = reviewSchema() as unknown as SchemaView

  it('is a closed object with a summary and a list of findings, both required', () => {
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual(['findings', 'summary'])
    expect([...schema.required].sort()).toEqual(['findings', 'summary'])
  })

  it('has findings that are closed objects with a severity from the list, a text and an optional node id', () => {
    const item = schema.properties.findings.items
    expect(item.additionalProperties).toBe(false)
    expect(item.properties.severity.enum).toEqual(['problem', 'warning', 'info'])
    expect(item.type).toBe('object')
    expect([...item.required].sort()).toEqual(['severity', 'text'])
    expect(Object.keys(item.properties).sort()).toEqual(['nodeId', 'severity', 'text'])
  })

  it('says the limits in words, and that a finding names a node only by an id from the workflow', () => {
    expect(schema.properties.summary.description).toMatch(/400 characters/)
    expect(schema.properties.findings.description).toMatch(/at most 10/i)
    expect(schema.properties.findings.items.properties.text.description).toMatch(/400 characters/)
    expect(schema.properties.findings.items.properties.nodeId.description).toMatch(/exists in the workflow/)
  })

  it('turns into a strict schema, with the node id nullable, and answers that restore to the same data', () => {
    const strict = strictify(reviewSchema())
    expect(strict.schema).toMatchObject({ additionalProperties: false })
    const sent = JSON.parse(JSON.stringify(strict.schema)) as { required: string[]; properties: { findings: { items: { required: string[] } } } }
    expect(sent.required).toEqual(['summary', 'findings'])
    expect(sent.properties.findings.items.required).toEqual(['severity', 'text', 'nodeId'])
    expect(strict.restore({ summary: 'x', findings: [{ severity: 'info', text: 'y', nodeId: null }] })).toEqual({ summary: 'x', findings: [{ severity: 'info', text: 'y' }] })
  })

  it('returns a fresh copy each time', () => {
    const first = reviewSchema() as { required: string[] }
    first.required.push('extra')
    expect((reviewSchema() as { required: string[] }).required).toEqual(['summary', 'findings'])
  })
})
