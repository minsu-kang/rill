// @vitest-environment node
import type { LlmModelInfo, PlanEffort } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { EFFORT_STEPS, effortLabelOf, stepAvailability } from '../src/chat/model/effort'

function modelWith(levels: PlanEffort[]): LlmModelInfo {
  return {
    provider: 'anthropic',
    id: 'm',
    tier: 'mid',
    label: 'M',
    contextTokens: 1000,
    capabilities: {
      structuredOutput: 'strict',
      documents: 'native-pdf',
      images: ['image/png'],
      cache: 'explicit',
      effortLevels: levels,
      effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      reasoningCappedByMaxTokens: false,
      streaming: 'optional',
      dataNote: 'note',
    },
  }
}

describe('EFFORT_STEPS', () => {
  it('maps the five labels to the five efforts in order, and only max is advanced', () => {
    expect(EFFORT_STEPS.map((step) => [step.label, step.effort, step.advanced])).toEqual([
      ['fast', 'low', false],
      ['normal', 'medium', false],
      ['careful', 'high', false],
      ['very_careful', 'xhigh', false],
      ['max', 'max', true],
    ])
  })

  it('finds the label of an effort', () => {
    expect(effortLabelOf('low')).toBe('fast')
    expect(effortLabelOf('xhigh')).toBe('very_careful')
    expect(effortLabelOf('max')).toBe('max')
  })
})

describe('stepAvailability', () => {
  it('follows the effort levels of the model', () => {
    const model = modelWith(['low', 'medium', 'high'])
    const result = EFFORT_STEPS.map((step) => stepAvailability(step, model))
    expect(result).toEqual([
      { enabled: true },
      { enabled: true },
      { enabled: true },
      { enabled: false, reason: 'model_unsupported' },
      { enabled: false, reason: 'model_unsupported' },
    ])
  })

  it('enables every step for a model that lists all five levels', () => {
    const model = modelWith(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(EFFORT_STEPS.every((step) => stepAvailability(step, model).enabled)).toBe(true)
  })

  it('disables every step when there is no model', () => {
    for (const step of EFFORT_STEPS) expect(stepAvailability(step, undefined)).toEqual({ enabled: false, reason: 'no_model' })
  })

  it('disables every step for a model that lists no level', () => {
    for (const step of EFFORT_STEPS) expect(stepAvailability(step, modelWith([])).enabled).toBe(false)
  })
})
