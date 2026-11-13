import { isValidCustomAuth, type AuthType, type CustomAuth } from '../../shared/host-api'

export type CustomField = 'keyName' | 'keyValue' | 'token' | 'username' | 'password'

export interface CustomFieldValues {
  keyName: string
  keyValue: string
  keyIn: string
  token: string
  username: string
  password: string
}

export type CustomAuthResult = { auth: CustomAuth } | { problem: 'missing' | 'invalid'; field: CustomField }

export const EMPTY_VALUES: CustomFieldValues = { keyName: '', keyValue: '', keyIn: 'header', token: '', username: '', password: '' }

export function buildCustomAuth(type: AuthType, values: CustomFieldValues): CustomAuthResult {
  const keyName = values.keyName.trim()
  const keyValue = values.keyValue.trim()
  const token = values.token.trim()
  const username = values.username.trim()
  switch (type) {
    case 'none':
      return { auth: { type: 'none' } }
    case 'apiKey': {
      if (keyName === '') return { problem: 'missing', field: 'keyName' }
      if (keyValue === '') return { problem: 'missing', field: 'keyValue' }
      const auth = { type: 'apiKey', in: values.keyIn === 'query' ? 'query' : 'header', name: keyName, value: keyValue } as const
      if (isValidCustomAuth(auth)) return { auth }
      return { problem: 'invalid', field: isValidCustomAuth({ ...auth, value: 'x' }) ? 'keyValue' : 'keyName' }
    }
    case 'bearer': {
      if (token === '') return { problem: 'missing', field: 'token' }
      const auth = { type: 'bearer', token } as const
      return isValidCustomAuth(auth) ? { auth } : { problem: 'invalid', field: 'token' }
    }
    case 'basic': {
      if (username === '') return { problem: 'missing', field: 'username' }
      const auth = { type: 'basic', username, password: values.password } as const
      if (isValidCustomAuth(auth)) return { auth }
      return { problem: 'invalid', field: isValidCustomAuth({ ...auth, password: '' }) ? 'password' : 'username' }
    }
  }
}
