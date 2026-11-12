import type { LlmProvider } from '@rill/llm'
import type { CallStatus, FieldOutcome } from './score'

export interface EvalCase {
  id: string
  group: string
  category: string
  tags: string[]
  kind: string
}

export interface RunContext {
  provider: LlmProvider
  signal: AbortSignal
}

export interface CaseScore {
  status: CallStatus
  outcomes: Record<string, FieldOutcome>
  extra: Record<string, number>
  partial?: Record<string, number>
  tags?: Record<string, readonly string[]>
}

export interface Suite<C extends EvalCase, O> {
  name: string
  version: string
  fields: readonly string[]
  cases(): C[]
  run(testCase: C, ctx: RunContext): Promise<O>
  score(testCase: C, output: O): CaseScore
  estimateInputTokens?(testCase: C): number
  worstCaseUsd?(testCase: C, model: string, maxOutputTokens: number): number | undefined
  /** A reason why a model cannot take this case (a PDF for a provider that reads none); the pair is then not run. */
  unsupportedReason?(testCase: C, model: string): string | undefined
}
