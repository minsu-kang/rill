import type { MessageKey } from '../../i18n'

const KEYS: Readonly<Record<string, MessageKey>> = {
  ACTIVATION_FAILED: 'app.wf.error.ACTIVATION_FAILED',
  NOT_FOUND: 'app.wf.error.NOT_FOUND',
  WORKFLOW_BUSY: 'app.wf.error.WORKFLOW_BUSY',
  INVALID_PARAMS: 'app.wf.error.INVALID_PARAMS',
  RULE_VIOLATION: 'app.wf.error.RULE_VIOLATION',
}

export const ENGINE_RULE_MESSAGE = 'the workflow breaks a rule you set; remove the rule or change the workflow'

export function engineErrorKey(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const message = error instanceof Error ? error.message : undefined
  if (code === 'ACTIVATION_FAILED' && message === ENGINE_RULE_MESSAGE) return 'app.wf.error.RULE_VIOLATION'
  return typeof code === 'string' && Object.hasOwn(KEYS, code) ? KEYS[code]! : 'app.wf.error.generic'
}
