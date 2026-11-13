import type { MessageKey } from '../../i18n'
import { HOST_ERROR_CODES, hostErrorCode } from '../../shared/host-api'

const KEYS: Readonly<Record<(typeof HOST_ERROR_CODES)[number], MessageKey>> = {
  INVALID_ARGUMENTS: 'app.error.host.INVALID_ARGUMENTS',
  INVALID_SETTINGS: 'app.error.host.INVALID_SETTINGS',
  NO_KEYCHAIN: 'app.error.host.NO_KEYCHAIN',
  NAME_COLLISION: 'app.error.host.NAME_COLLISION',
  SECRETS_UNREADABLE: 'app.error.host.SECRETS_UNREADABLE',
  ENGINE_UNAVAILABLE: 'app.error.host.ENGINE_UNAVAILABLE',
  ATTACHMENT_REJECTED: 'app.error.host.ATTACHMENT_REJECTED',
  FILE_TOO_LARGE: 'app.error.host.FILE_TOO_LARGE',
  FILE_REJECTED: 'app.error.host.FILE_REJECTED',
  KEY_INVALID: 'app.error.host.KEY_INVALID',
  KEY_MALFORMED: 'app.error.host.KEY_MALFORMED',
  TOKEN_INVALID: 'app.error.host.TOKEN_INVALID',
  SUPERSEDED: 'app.error.host.SUPERSEDED',
  OAUTH_UNAVAILABLE: 'app.error.host.OAUTH_UNAVAILABLE',
  INTERNAL: 'app.error.host.INTERNAL',
}

export function hostErrorKey(error: unknown): MessageKey {
  return KEYS[hostErrorCode(error)]
}
