import { estimateCallUsd } from '../../pricing'
import { PDF_INPUT_TOKENS, PNG_INPUT_TOKENS, TEXT_CHARS_PER_TOKEN, TEXT_OVERHEAD_TOKENS } from '../extract/suite'
import type { ResolvedAttachment } from './attachments'
import type { CaseSpec } from './schema'

export const DEFAULT_MAX_REPAIR_ROUNDS = 3
export const TARGETED_EXTRA_CALLS = 2
export const BASE_INPUT_TOKENS = 4500
export const HISTORY_TOKENS_PER_REPAIR_ROUND = 4000
export const TYPICAL_OUTPUT_TOKENS = 3000

export function worstCaseCalls(maxRepairRounds: number): number {
  return 1 + maxRepairRounds + TARGETED_EXTRA_CALLS
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

export function firstCallInputTokens(spec: CaseSpec, attachments: readonly ResolvedAttachment[]): number {
  const text = Math.ceil(contextChars(spec) / TEXT_CHARS_PER_TOKEN)
  return BASE_INPUT_TOKENS + text + attachments.reduce((total, file) => total + attachmentTokens(file), 0)
}

export function worstCallInputTokens(firstCall: number, maxRepairRounds: number): number {
  return firstCall + maxRepairRounds * HISTORY_TOKENS_PER_REPAIR_ROUND
}

export function plannerWorstCaseUsd(model: string, firstCall: number, maxRepairRounds: number, maxOutputTokens: number): number | undefined {
  const call = estimateCallUsd(model, worstCallInputTokens(firstCall, maxRepairRounds), maxOutputTokens)
  return call === undefined ? undefined : call * worstCaseCalls(maxRepairRounds)
}
