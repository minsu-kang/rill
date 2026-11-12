import type { LlmModelInfo, PlanEffort } from '@rill/protocol'

export type EffortLabel = 'fast' | 'normal' | 'careful' | 'very_careful' | 'max'
export type EffortStep = { label: EffortLabel; effort: PlanEffort; advanced: boolean }
export type EffortHint = { effort: PlanEffort; costUsd?: number; latencyMs?: number; basis: string }

export const EFFORT_STEPS: readonly EffortStep[] = [
  { label: 'fast', effort: 'low', advanced: false },
  { label: 'normal', effort: 'medium', advanced: false },
  { label: 'careful', effort: 'high', advanced: false },
  { label: 'very_careful', effort: 'xhigh', advanced: false },
  { label: 'max', effort: 'max', advanced: true },
]

export function effortLabelOf(effort: PlanEffort): EffortLabel {
  return EFFORT_STEPS.find((step) => step.effort === effort)!.label
}

export function stepAvailability(step: EffortStep, model: LlmModelInfo | undefined): { enabled: boolean; reason?: 'model_unsupported' | 'no_model' } {
  if (model === undefined) return { enabled: false, reason: 'no_model' }
  return model.capabilities.effortLevels.includes(step.effort) ? { enabled: true } : { enabled: false, reason: 'model_unsupported' }
}
