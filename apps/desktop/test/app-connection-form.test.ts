import { describe, expect, it } from 'vitest'
import { EMPTY_VALUES, buildCustomAuth, type CustomFieldValues } from '../src/app/settings/connection-form'
import { createTranslator } from '../src/i18n'
import { isValidCustomAuth } from '../src/shared/host-api'

const values = (patch: Partial<CustomFieldValues>): CustomFieldValues => ({ ...EMPTY_VALUES, ...patch })

describe('buildCustomAuth', () => {
  it('builds each auth type from its own fields only', () => {
    expect(buildCustomAuth('none', values({ token: 'ignored', keyName: 'ignored' }))).toEqual({ auth: { type: 'none' } })
    expect(buildCustomAuth('apiKey', values({ keyName: ' X-Key ', keyValue: ' v1 ', keyIn: 'query', token: 'ignored' }))).toEqual({ auth: { type: 'apiKey', in: 'query', name: 'X-Key', value: 'v1' } })
    expect(buildCustomAuth('apiKey', values({ keyName: 'X-Key', keyValue: 'v1', keyIn: 'anything' }))).toEqual({ auth: { type: 'apiKey', in: 'header', name: 'X-Key', value: 'v1' } })
    expect(buildCustomAuth('bearer', values({ token: ' tok ' }))).toEqual({ auth: { type: 'bearer', token: 'tok' } })
    expect(buildCustomAuth('basic', values({ username: ' me ', password: ' p w ' }))).toEqual({ auth: { type: 'basic', username: 'me', password: ' p w ' } })
    expect(buildCustomAuth('basic', values({ username: 'me' }))).toEqual({ auth: { type: 'basic', username: 'me', password: '' } })
  })

  it('names the first empty required field', () => {
    expect(buildCustomAuth('apiKey', values({ keyValue: 'v' }))).toEqual({ problem: 'missing', field: 'keyName' })
    expect(buildCustomAuth('apiKey', values({ keyName: 'k', keyValue: '  ' }))).toEqual({ problem: 'missing', field: 'keyValue' })
    expect(buildCustomAuth('bearer', values({}))).toEqual({ problem: 'missing', field: 'token' })
    expect(buildCustomAuth('basic', values({ password: 'p' }))).toEqual({ problem: 'missing', field: 'username' })
  })

  it('names the field that the engine would refuse', () => {
    expect(buildCustomAuth('apiKey', values({ keyName: 'bad name', keyValue: 'v' }))).toEqual({ problem: 'invalid', field: 'keyName' })
    expect(buildCustomAuth('apiKey', values({ keyName: 'Host', keyValue: 'v' }))).toEqual({ problem: 'invalid', field: 'keyName' })
    expect(buildCustomAuth('apiKey', values({ keyName: 'k', keyValue: 'a\u0001b' }))).toEqual({ problem: 'invalid', field: 'keyValue' })
    expect(buildCustomAuth('bearer', values({ token: 't'.repeat(2001) }))).toEqual({ problem: 'invalid', field: 'token' })
    expect(buildCustomAuth('basic', values({ username: 'a:b' }))).toEqual({ problem: 'invalid', field: 'username' })
    expect(buildCustomAuth('basic', values({ username: 'a', password: 'p'.repeat(2001) }))).toEqual({ problem: 'invalid', field: 'password' })
  })

  it('only ever returns an object that the host accepts', () => {
    for (const result of [buildCustomAuth('none', EMPTY_VALUES), buildCustomAuth('bearer', values({ token: 't' }))]) {
      expect('auth' in result && isValidCustomAuth(result.auth)).toBe(true)
    }
  })
})

describe('the invalid-values message', () => {
  it('tells the user that reserved header names are refused, in both languages', () => {
    expect(createTranslator('en')('app.connections.custom.invalid')).toMatch(/reserved header name/)
    expect(createTranslator('ko')('app.connections.custom.invalid')).toContain('예약')
  })
})
