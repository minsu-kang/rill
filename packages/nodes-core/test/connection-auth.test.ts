import { describe, expect, it } from 'vitest'
import {
  applyConnectionAuth,
  encodeConnectionSecret,
  maskSecretParts,
  parseConnectionAuth,
  parseConnectionSecret,
  secretParts,
  type ConnectionAuth,
} from '../src/connection-auth'

const text = (value: unknown): string => JSON.stringify(value)

const valid: ConnectionAuth[] = [
  { type: 'none' },
  { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: 'CONN-SECRET-MARKER' },
  { type: 'apiKey', in: 'query', name: 'api_key', value: 'CONN-SECRET-MARKER' },
  { type: 'bearer', token: 'CONN-SECRET-MARKER' },
  { type: 'basic', username: 'user', password: 'CONN-SECRET-MARKER' },
  { type: 'basic', username: '민수', password: '' },
]

describe('parseConnectionSecret', () => {
  it.each(valid)('accepts %j and round-trips it', (auth) => {
    expect(parseConnectionSecret(encodeConnectionSecret(auth))).toEqual({ kind: 'structured', auth })
  })

  it('marks the encoded string with rillAuth 1', () => {
    expect(JSON.parse(encodeConnectionSecret({ type: 'bearer', token: 'abcd' }))).toEqual({ rillAuth: 1, type: 'bearer', token: 'abcd' })
  })

  it.each(['abc123', 'Bearer abc', '', '{', '[1]', 'null', '"x"', '{"a":1}', '{"type":"bearer","token":"x"}', '{"rillAuth":"1"}x'])(
    'treats %j as a plain legacy secret',
    (secret) => {
      expect(parseConnectionSecret(secret)).toEqual({ kind: 'plain' })
    },
  )

  const malformed: Record<string, unknown> = {
    'an extra key': { rillAuth: 1, type: 'bearer', token: 'abcd', extra: 1 },
    'a wrong rillAuth number': { rillAuth: 2, type: 'bearer', token: 'abcd' },
    'a wrong rillAuth type': { rillAuth: '1', type: 'bearer', token: 'abcd' },
    'an unknown type': { rillAuth: 1, type: 'digest' },
    'a missing type': { rillAuth: 1 },
    'a missing token': { rillAuth: 1, type: 'bearer' },
    'a token that is not a string': { rillAuth: 1, type: 'bearer', token: 5 },
    'an empty token': { rillAuth: 1, type: 'bearer', token: '' },
    'a none with a field': { rillAuth: 1, type: 'none', token: 'abcd' },
    'a bad header name character': { rillAuth: 1, type: 'apiKey', in: 'header', name: 'bad name', value: 'abcd' },
    'a non-ASCII header name': { rillAuth: 1, type: 'apiKey', in: 'header', name: 'Ключ', value: 'abcd' },
    'an empty name': { rillAuth: 1, type: 'apiKey', in: 'header', name: '', value: 'abcd' },
    'a 129 character name': { rillAuth: 1, type: 'apiKey', in: 'query', name: 'a'.repeat(129), value: 'abcd' },
    'a wrong location': { rillAuth: 1, type: 'apiKey', in: 'cookie', name: 'key', value: 'abcd' },
    'a missing location': { rillAuth: 1, type: 'apiKey', name: 'key', value: 'abcd' },
    'a control character in a value': { rillAuth: 1, type: 'apiKey', in: 'header', name: 'key', value: 'ab\ncd' },
    'a control character in a token': { rillAuth: 1, type: 'bearer', token: 'ab\u0000cd' },
    'a DEL in a token': { rillAuth: 1, type: 'bearer', token: 'ab\u007fcd' },
    'a 2001 character token': { rillAuth: 1, type: 'bearer', token: 'a'.repeat(2001) },
    'a colon in the username': { rillAuth: 1, type: 'basic', username: 'us:er', password: 'pw' },
    'an empty username': { rillAuth: 1, type: 'basic', username: '', password: 'pw' },
    'a 257 character username': { rillAuth: 1, type: 'basic', username: 'u'.repeat(257), password: 'pw' },
    'a control character in the username': { rillAuth: 1, type: 'basic', username: 'us\ter', password: 'pw' },
    'a 2001 character password': { rillAuth: 1, type: 'basic', username: 'user', password: 'p'.repeat(2001) },
    'a control character in the password': { rillAuth: 1, type: 'basic', username: 'user', password: 'p\rw' },
    'a missing password': { rillAuth: 1, type: 'basic', username: 'user' },
  }
  for (const name of ['Host', 'content-length', 'TRANSFER-ENCODING', 'Connection', 'cookie', 'Set-Cookie']) {
    malformed[`the forbidden name ${name}`] = { rillAuth: 1, type: 'apiKey', in: 'header', name, value: 'abcd' }
  }

  it.each(Object.entries(malformed))('flags %s as malformed', (_label, value) => {
    expect(parseConnectionSecret(text(value))).toEqual({ kind: 'malformed' })
  })

  it('accepts the limits exactly', () => {
    const edge: ConnectionAuth[] = [
      { type: 'apiKey', in: 'header', name: 'a'.repeat(128), value: 'v'.repeat(2000) },
      { type: 'bearer', token: 't'.repeat(2000) },
      { type: 'basic', username: 'u'.repeat(256), password: 'p'.repeat(2000) },
      { type: 'apiKey', in: 'query', name: "!#$%&'*+-.^_`|~09azAZ", value: 'x' },
    ]
    for (const auth of edge) expect(parseConnectionSecret(encodeConnectionSecret(auth))).toEqual({ kind: 'structured', auth })
  })

  it('never puts a value in a parser result for a malformed secret', () => {
    expect(JSON.stringify(parseConnectionSecret(text(malformed['an extra key'])))).not.toContain('abcd')
  })
})

describe('parseConnectionAuth', () => {
  it('accepts an object without rillAuth and rejects one with it', () => {
    expect(parseConnectionAuth({ type: 'bearer', token: 'abcd' })).toEqual({ type: 'bearer', token: 'abcd' })
    expect(parseConnectionAuth({ rillAuth: 1, type: 'bearer', token: 'abcd' })).toBeUndefined()
    expect(parseConnectionAuth(null)).toBeUndefined()
    expect(parseConnectionAuth([])).toBeUndefined()
  })
})

describe('applyConnectionAuth', () => {
  it('sets a header and replaces one of the same name in any case', () => {
    const out = applyConnectionAuth({ type: 'apiKey', in: 'header', name: 'X-Api-Key', value: 'k1' }, 'http://h.test/p', { 'x-api-key': 'old', Other: '1' })
    expect(out.headers).toEqual({ Other: '1', 'X-Api-Key': 'k1' })
    expect(out.url).toBe('http://h.test/p')
  })

  it('appends a query parameter, keeping the others and their encoding', () => {
    const out = applyConnectionAuth({ type: 'apiKey', in: 'query', name: 'key', value: 'k 1&=#é' }, 'http://h.test/p?a=b%20c&d=e+f', {})
    expect(out.url).toBe('http://h.test/p?a=b%20c&d=e+f&key=k%201%26%3D%23%C3%A9')
  })

  it('replaces every parameter of the same name', () => {
    const out = applyConnectionAuth({ type: 'apiKey', in: 'query', name: 'key', value: 'new' }, 'http://h.test/p?key=old&x=1&k%65y=old2', {})
    expect(out.url).toBe('http://h.test/p?x=1&key=new')
  })

  it('encodes characters that URLSearchParams would leave', () => {
    const out = applyConnectionAuth({ type: 'apiKey', in: 'query', name: 'k', value: "!'()*" }, 'http://h.test/p', {})
    expect(out.url).toBe('http://h.test/p?k=%21%27%28%29%2A')
  })

  it('builds Bearer and Basic and replaces an Authorization header', () => {
    expect(applyConnectionAuth({ type: 'bearer', token: 'tok' }, 'http://h.test/', { authorization: 'x' }).headers).toEqual({ Authorization: 'Bearer tok' })
    const basic = applyConnectionAuth({ type: 'basic', username: '민수', password: 'pä:ss' }, 'http://h.test/', {}).headers.Authorization!
    expect(Buffer.from(basic.replace('Basic ', ''), 'base64').toString('utf8')).toBe('민수:pä:ss')
  })

  it('adds nothing for none', () => {
    expect(applyConnectionAuth({ type: 'none' }, 'http://h.test/?a=1', { A: 'b' })).toEqual({ url: 'http://h.test/?a=1', headers: { A: 'b' } })
  })
})

describe('secretParts and maskSecretParts', () => {
  it('lists the components and the base64 login of a structured secret', () => {
    const basic = encodeConnectionSecret({ type: 'basic', username: 'someone', password: 'CONN-SECRET-MARKER' })
    const parts = secretParts(basic)
    expect(parts).toContain('CONN-SECRET-MARKER')
    expect(parts).toContain('someone:CONN-SECRET-MARKER')
    expect(parts).toContain(Buffer.from('someone:CONN-SECRET-MARKER').toString('base64'))
    expect(parts).not.toContain('someone')
    expect(secretParts(encodeConnectionSecret({ type: 'bearer', token: 'CONN-SECRET-MARKER' }))).toEqual(['CONN-SECRET-MARKER'])
    expect(secretParts(encodeConnectionSecret({ type: 'apiKey', in: 'query', name: 'k', value: 'CONN-SECRET-MARKER' }))).toEqual(['CONN-SECRET-MARKER'])
    expect(secretParts(encodeConnectionSecret({ type: 'none' }))).toEqual([])
    expect(secretParts('plain-secret')).toEqual([])
  })

  it('masks raw and percent-encoded forms and leaves short parts alone', () => {
    expect(maskSecretParts('a CONN-SECRET-MARKER b CONN-SECRET-MARKER', ['CONN-SECRET-MARKER'])).toBe('a <secret> b <secret>')
    expect(maskSecretParts('k=k%201%26', ['k 1&'])).toBe('k=<secret>')
    expect(maskSecretParts('abc', ['abc'])).toBe('abc')
  })
})
