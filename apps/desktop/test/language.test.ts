import { describe, expect, it } from 'vitest'
import { localeFor } from '../src/renderer-shell/language'

describe('localeFor', () => {
  it.each(['ko', 'ko-KR', 'KO', 'ko_KR', 'Ko-kr'])('follows a system language that starts with ko: %s', (system) => {
    expect(localeFor('system', system)).toBe('ko')
  })

  it.each(['en', 'en-US', 'ja-JP', 'de', 'kor', 'ok-KO', '', ' ko'])('follows every other system language as English: %j', (system) => {
    expect(localeFor('system', system)).toBe('en')
  })

  it('treats a missing system language as English', () => {
    expect(localeFor('system', undefined)).toBe('en')
  })

  it('ignores the system language when the user chose one', () => {
    expect(localeFor('en', 'ko-KR')).toBe('en')
    expect(localeFor('ko', 'en-US')).toBe('ko')
    expect(localeFor('ko', '')).toBe('ko')
  })
})
