import type { MessageKey } from '../../i18n'

const KEYS: Readonly<Record<string, MessageKey>> = {
  ACTIVATION_FAILED: 'app.wf.error.ACTIVATION_FAILED',
  NOT_FOUND: 'app.wf.error.NOT_FOUND',
  INVALID_PARAMS: 'app.wf.error.INVALID_PARAMS',
}

export function engineErrorKey(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && Object.hasOwn(KEYS, code) ? KEYS[code]! : 'app.wf.error.generic'
}
