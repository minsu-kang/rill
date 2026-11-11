import { PlanError } from '@rill/planner'
import { describe, expect, it } from 'vitest'
import { ERROR_ISSUE, fakeRound } from '../src/suites/planner/fake-results'
import { planErrorJson, serializablePlanError } from '../src/suites/planner/error-json'
import { FAKE_MODEL, runFake } from './planner-helpers'

const rounds = [fakeRound(0, [ERROR_ISSUE]), fakeRound(1, [ERROR_ISSUE])]
const make = (message: string, cause?: unknown) => new PlanError('invalid_after_repair', message, rounds, [ERROR_ISSUE], cause === undefined ? undefined : { cause })
const parsed = (error: PlanError): Record<string, unknown> => JSON.parse(JSON.stringify(error)) as Record<string, unknown>

describe('a plan error in the results', () => {
  it('loses its message and cause in plain JSON, which is why it needs a serialiser', () => {
    const plain = parsed(make('no valid answer after 3 repair rounds', new Error('inner')))
    expect(plain).not.toHaveProperty('message')
    expect(plain).not.toHaveProperty('cause')
  })

  it('keeps the kind, the message, the message of the cause, the rounds and the last issues', () => {
    const json = parsed(serializablePlanError(make('no valid answer after 3 repair rounds', new Error('the model provider failed: overloaded'))))
    expect(json).toMatchObject({
      name: 'PlanError',
      kind: 'invalid_after_repair',
      message: 'no valid answer after 3 repair rounds',
      cause: 'the model provider failed: overloaded',
      lastIssues: [ERROR_ISSUE],
    })
    expect(json['rounds']).toHaveLength(2)
  })

  it('leaves the cause out when there is none or when it is not an error, and never copies its other fields', () => {
    expect(parsed(serializablePlanError(make('plain')))).not.toHaveProperty('cause')
    expect(parsed(serializablePlanError(make('text cause', 'just a string')))).not.toHaveProperty('cause')
    const rich = Object.assign(new Error('inner'), { ref: { name: 'sample-1.pdf' }, content: 'RECEIPT TOTAL 42', stack: 'SECRET-STACK' })
    const text = JSON.stringify(serializablePlanError(make('with cause', rich)))
    expect(text).toContain('"cause":"inner"')
    expect(text).not.toContain('RECEIPT TOTAL')
    expect(text).not.toContain('sample-1.pdf')
    expect(text).not.toContain('SECRET-STACK')
  })

  it('collapses the whitespace of the cause and cuts it at 300 characters', () => {
    const json = planErrorJson(make('long', new Error(`first\n\n  second ${'x'.repeat(400)}`)))
    expect(String(json['cause'])).toMatch(/^first second x+\.\.\.$/u)
    expect(String(json['cause']).length).toBeLessThanOrEqual(303)
  })

  it('stays an Error for the rest of the harness', () => {
    const error = serializablePlanError(make('still an error'))
    expect(error).toBeInstanceOf(PlanError)
    expect(error.message).toBe('still an error')
    expect(Object.keys(error)).not.toContain('toJSON')
  })

  it('is what the suite hands to the runner, so the stored output carries the message and the cause', async () => {
    const { tasks } = await runFake(
      () => ({ plan: () => Promise.reject(make('no valid answer after 3 repair rounds', new Error('the model reply was cut off'))) }),
      { only: 'easy-03-webhook-to-slack' },
      [FAKE_MODEL],
    )
    const stored = JSON.parse(JSON.stringify(tasks[0]!.output)) as Record<string, unknown>
    expect(stored).toMatchObject({ kind: 'invalid_after_repair', message: 'no valid answer after 3 repair rounds', cause: 'the model reply was cut off' })
  })
})
