import type { EXPLAIN_SIGNALS, ExplainResult } from '@rill/protocol'
import type { MessageKey } from '../../i18n'

type Action = ExplainResult['suggestedActions'][number]

export function causeKey(cause: ExplainResult['likelyCause']): MessageKey {
  return `explain.cause.${cause}`
}

export function actionKey(action: Action): MessageKey {
  return `explain.action.${action}`
}

export function signalKey(signal: (typeof EXPLAIN_SIGNALS)[number]): MessageKey {
  return `explain.signal.${signal}`
}

export function isStateChanging(action: Action): boolean {
  return action === 'retry_run' || action === 'deactivate_workflow'
}

export const HIDDEN_MARK = '<hidden>'
