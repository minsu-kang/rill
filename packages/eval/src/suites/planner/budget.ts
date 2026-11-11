import { STREAMING_ABOVE_MAX_TOKENS } from '@rill/llm'
import { createCoreRegistry, type NodeRegistry } from '@rill/nodes-core'
import { ATTACHMENT_RULES, EFFORT_BUDGETS, MAX_TARGETED_NODES, PLANNER_RULES, catalogText, generationSchema, type PlanEffort } from '@rill/planner'
import { estimateCallUsd } from '../../pricing'
import { PDF_INPUT_TOKENS, PNG_INPUT_TOKENS, TEXT_CHARS_PER_TOKEN, TEXT_OVERHEAD_TOKENS } from '../extract/suite'
import type { ResolvedAttachment } from './attachments'
import type { CaseSpec } from './schema'

export const DEFAULT_MAX_REPAIR_ROUNDS = 3
export const TARGETED_CALLS_PER_ROUND = MAX_TARGETED_NODES
export const BASE_INPUT_MARGIN = 1.15
export const REPAIR_MESSAGE_TOKENS = 3000
export const TYPICAL_OUTPUT_TOKENS = 3000
export const PLANNER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly PlanEffort[]
export const PLANNER_MAX_OUTPUT_TOKENS = STREAMING_ABOVE_MAX_TOKENS

export function effortMaxTokens(effort: PlanEffort): number {
  return EFFORT_BUDGETS[effort].maxTokens
}

export function isMeasurableEffort(effort: PlanEffort): boolean {
  return effortMaxTokens(effort) <= PLANNER_MAX_OUTPUT_TOKENS
}

export function measurableEfforts(): PlanEffort[] {
  return PLANNER_EFFORTS.filter(isMeasurableEffort)
}

export function effortTable(options: { measurableOnly?: boolean } = {}): string {
  return PLANNER_EFFORTS.filter((effort) => options.measurableOnly !== true || isMeasurableEffort(effort))
    .map((effort) => `${effort} ${effortMaxTokens(effort)}${isMeasurableEffort(effort) ? '' : ' (not measurable)'}`)
    .join(', ')
}

export function unmeasurableEffortMessage(efforts: readonly string[]): string {
  return `effort ${efforts.join(', ')} cannot be measured: the planner asks for more than ${PLANNER_MAX_OUTPUT_TOKENS} output tokens there, the provider then streams the reply and the harness cannot read the usage of a streamed reply. Use ${measurableEfforts().join(', ')}.`
}

export function worstCaseCalls(maxRepairRounds: number): number {
  return 1 + maxRepairRounds * TARGETED_CALLS_PER_ROUND
}

export function historyTokensPerRepairRound(maxOutputTokens: number): number {
  return maxOutputTokens + REPAIR_MESSAGE_TOKENS
}

export function baseInputTokens(registry: NodeRegistry): number {
  const schemaChars = Math.max(
    ...(['create', 'patch'] as const).map((mode) => JSON.stringify(generationSchema(registry, { mode, allowQuestions: true })).length),
  )
  const chars = PLANNER_RULES.length + ATTACHMENT_RULES.length + catalogText(registry).length + schemaChars
  return Math.ceil((chars / TEXT_CHARS_PER_TOKEN) * BASE_INPUT_MARGIN)
}

let coreBaseInputTokens: number | undefined

function defaultBaseInputTokens(): number {
  coreBaseInputTokens ??= baseInputTokens(createCoreRegistry())
  return coreBaseInputTokens
}

function contextChars(spec: CaseSpec): number {
  const { context } = spec
  const workflow = context.existingWorkflow === undefined ? 0 : JSON.stringify(context.existingWorkflow).length
  return spec.prompt.length + workflow + context.connections.join(', ').length + context.allowedFolders.join(', ').length
}

function attachmentTokens(file: ResolvedAttachment): number {
  if (file.spec.kind === 'pdf') return PDF_INPUT_TOKENS
  if (file.spec.kind === 'png') return PNG_INPUT_TOKENS
  return Math.ceil(new TextDecoder().decode(file.bytes).length / TEXT_CHARS_PER_TOKEN) + TEXT_OVERHEAD_TOKENS
}

export function firstCallInputTokens(spec: CaseSpec, attachments: readonly ResolvedAttachment[], base: number = defaultBaseInputTokens()): number {
  const text = Math.ceil(contextChars(spec) / TEXT_CHARS_PER_TOKEN)
  return base + text + attachments.reduce((total, file) => total + attachmentTokens(file), 0)
}

export function worstCallInputTokens(firstCall: number, maxRepairRounds: number, maxOutputTokens: number): number {
  return firstCall + maxRepairRounds * historyTokensPerRepairRound(maxOutputTokens)
}

export function plannerWorstCaseUsd(model: string, firstCall: number, maxRepairRounds: number, maxOutputTokens: number): number | undefined {
  const call = estimateCallUsd(model, worstCallInputTokens(firstCall, maxRepairRounds, maxOutputTokens), maxOutputTokens)
  return call === undefined ? undefined : call * worstCaseCalls(maxRepairRounds)
}
