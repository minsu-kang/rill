import { describe, expect, it } from 'vitest'
import { ACCOUNT_KINDS, accessTokenOf, accountLabel, isAccountKind } from '../src/index'

const resolver = (secret: string | undefined, kind?: string) => ({ get: () => secret, ...(kind === undefined ? {} : { kindOf: () => kind }) })

describe('account connection kinds', () => {
  it('lists google and microsoft and nothing else', () => {
    expect([...ACCOUNT_KINDS]).toEqual(['google', 'microsoft'])
    expect(isAccountKind('google')).toBe(true)
    expect(isAccountKind('microsoft')).toBe(true)
    for (const other of ['slack', 'http', 'webhookSecret', 'Google', '', undefined, null, 1]) expect(isAccountKind(other)).toBe(false)
    expect(accountLabel('google')).toBe('Google')
    expect(accountLabel('microsoft')).toBe('Microsoft')
  })
})

describe('accessTokenOf', () => {
  it('returns a token made of bearer characters', () => {
    for (const token of ['ya29.TOKENMARKER0123456789', 'eyJTOKENMARKER0123456789.payload.sig', 'abc-DEF_123~+/xyz==', 'a'.repeat(8), 'a'.repeat(8192)]) {
      expect(accessTokenOf(resolver(token, 'google'), 'c', 'google')).toBe(token)
    }
  })

  it('refuses a token that is too short, too long or has a character outside the bearer set', () => {
    for (const token of ['a'.repeat(7), 'a'.repeat(8193), 'abc def ghi', 'abc\ndefgh', 'abc"defgh', 'abc,defgh', 'abc;defgh', '{abcdefgh}', 'abcdefgh===='] ) {
      expect(() => accessTokenOf(resolver(token, 'google'), 'c', 'google'), JSON.stringify(token)).toThrow('the connection does not hold an access token')
    }
  })

  it('fails for an unknown name before anything else', () => {
    expect(() => accessTokenOf(resolver(undefined, 'http'), 'c', 'google')).toThrow('unknown connection: c')
  })

  it('refuses a connection that has no kind, whether the resolver has no kinds or gives none for the name', () => {
    const token = 'ya29.TOKENMARKER0123456789'
    for (const kind of ['google', 'microsoft'] as const) {
      expect(() => accessTokenOf(resolver(token), 'c', kind)).toThrow(`connection c has no kind, give it the kind ${kind}`)
      expect(() => accessTokenOf({ get: () => token, kindOf: () => undefined }, 'c', kind)).toThrow(`connection c has no kind, give it the kind ${kind}`)
    }
    expect(() => accessTokenOf(resolver(token), 'my sheets', 'google')).toThrow('connection my sheets has no kind, give it the kind google')
  })

  it('names no part of the secret when it refuses for a missing or a wrong kind', () => {
    for (const kind of [undefined, 'microsoft']) {
      try {
        accessTokenOf(resolver('ya29.TOKENMARKER0123456789', kind), 'c', 'google')
        throw new Error('did not refuse')
      } catch (error) {
        expect((error as Error).message).not.toContain('TOKENMARKER')
      }
    }
  })

  it('compares the kind of the connection with the kind that the node needs', () => {
    expect(accessTokenOf(resolver('ya29.TOKENMARKER0123456789', 'google'), 'c', 'google')).toBe('ya29.TOKENMARKER0123456789')
    expect(accessTokenOf(resolver('eyJTOKENMARKER0123456789.payload.sig', 'microsoft'), 'c', 'microsoft')).toBe('eyJTOKENMARKER0123456789.payload.sig')
    expect(() => accessTokenOf(resolver('ya29.TOKENMARKER0123456789', 'microsoft'), 'c', 'google')).toThrow('connection c is a microsoft connection, not a google connection')
    expect(() => accessTokenOf(resolver('ya29.TOKENMARKER0123456789', 'google'), 'c', 'microsoft')).toThrow('connection c is a google connection, not a microsoft connection')
  })
})
