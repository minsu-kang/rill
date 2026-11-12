import type { ExplainEffort, ExplainResult, RunSummary } from '@rill/protocol'
import type { MessageKey } from '../../i18n'

export type ExplainState =
  | { phase: 'idle' }
  | { phase: 'confirming'; effort: ExplainEffort }
  | { phase: 'asking'; effort: ExplainEffort; requestId: number }
  | { phase: 'done'; result: ExplainResult }
  | { phase: 'error'; key: MessageKey }

export type ExplainAction =
  | { type: 'open'; effort: ExplainEffort }
  | { type: 'cancel' }
  | { type: 'send'; effort: ExplainEffort; requestId: number }
  | { type: 'succeeded'; requestId: number; result: ExplainResult }
  | { type: 'failed'; requestId: number; key: MessageKey }
  | { type: 'reset' }

export const IDLE_EXPLAIN: ExplainState = { phase: 'idle' }

export function explainReducer(state: ExplainState, action: ExplainAction): ExplainState {
  switch (action.type) {
    case 'open':
      return state.phase === 'asking' ? state : { phase: 'confirming', effort: action.effort }
    case 'cancel':
      return state.phase === 'confirming' ? IDLE_EXPLAIN : state
    case 'send':
      return state.phase === 'asking' ? state : { phase: 'asking', effort: action.effort, requestId: action.requestId }
    case 'succeeded':
      return state.phase === 'asking' && state.requestId === action.requestId ? { phase: 'done', result: action.result } : state
    case 'failed':
      return state.phase === 'asking' && state.requestId === action.requestId ? { phase: 'error', key: action.key } : state
    case 'reset':
      return IDLE_EXPLAIN
  }
}

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({
  NOT_FOUND: 'explain.error.notFound',
  RUN_NOT_EXPLAINABLE: 'explain.error.notExplainable',
  LLM_UNAVAILABLE: 'explain.error.llmUnavailable',
  EXPLAIN_BUSY: 'explain.error.busy',
  EXPLAIN_PROVIDER: 'explain.error.provider',
  EXPLAIN_INVALID: 'explain.error.invalid',
  INVALID_PARAMS: 'explain.error.params',
})

export function explainErrorKey(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code]! : 'explain.error.generic'
}

export function canExplain(run: Pick<RunSummary, 'status'> | undefined): boolean {
  return run?.status === 'failed'
}
