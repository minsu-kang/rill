import type { LlmModelInfo, PlanEffort } from '@rill/protocol'
import { effortRank } from '../../model/rules'

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

export type StepReason = 'model_unsupported' | 'no_model' | 'rule_cap'

export function stepAvailability(step: EffortStep, model: LlmModelInfo | undefined, cap?: PlanEffort): { enabled: boolean; reason?: StepReason } {
  if (model === undefined) return { enabled: false, reason: 'no_model' }
  if (cap !== undefined && effortRank(step.effort) > effortRank(cap)) return { enabled: false, reason: 'rule_cap' }
  return model.capabilities.effortLevels.includes(step.effort) ? { enabled: true } : { enabled: false, reason: 'model_unsupported' }
}
