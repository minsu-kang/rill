import { describe, expect, it } from 'vitest'
import { createRedactor, excerpt } from '../../src/explain/excerpt'

const none = createRedactor([])
const plain = (value: unknown, options: Parameters<typeof excerpt>[2] = {}): string => excerpt(value, none, options)
const hide = (text: string, secrets: string[] = []): string => createRedactor(secrets).string(text)

describe('key names', () => {
  it('hides a key that spells a credential without a separator or in capitals', () => {
    for (const key of ['privatekey', 'PRIVATEKEY', 'accesskey', 'AccessKey', 'SECRETKEY']) expect(plain({ [key]: 'VALUE-1' }), key).toBe(`{"${key}":"<redacted>"}`)
  })

  it('keeps a key that only ends in Key after more letters, or has a credential word in its middle', () => {
    expect(plain({ primaryKeyName: 'VALUE-1', keyName: 'VALUE-2', monKeyPath: 'VALUE-3' })).toBe('{"primaryKeyName":"VALUE-1","keyName":"VALUE-2","monKeyPath":"VALUE-3"}')
  })

  it('checks the first 200 characters of a key for a credential word', () => {
    const key = `${'k'.repeat(192)}password`
    expect(key).toHaveLength(200)
    expect(plain({ [key]: 'VALUE-1' })).toContain('"<redacted>"')
    expect(plain({ [key]: 'VALUE-1' })).not.toContain('VALUE-1')
  })

  it('treats a key called headers in any case as headers', () => {
    expect(plain({ Headers: { 'X-Custom': 'VALUE-1', 'Content-Type': 'text/plain' } })).toBe('{"Headers":{"X-Custom":"<redacted>","Content-Type":"text/plain"}}')
    expect(plain({ HEADERS: { 'X-Custom': 'VALUE-1' } })).toBe('{"HEADERS":{"X-Custom":"<redacted>"}}')
  })
})

describe('credentials in the query of a URL', () => {
  it('hides the value of every credential word, however short the value', () => {
    const query = ['token', 'secret', 'password', 'passwd', 'key', 'sig', 'signature', 'auth', 'credential', 'session'].map((name) => `${name}=v1`).join('&')
    const expected = ['token', 'secret', 'password', 'passwd', 'key', 'sig', 'signature', 'auth', 'credential', 'session'].map((name) => `${name}=<redacted>`).join('&')
    expect(hide(`https://api.example.com/x?${query}&page=2`)).toBe(`https://api.example.com/x?${expected}&page=2`)
  })

  it('reads a semicolon as the start of a parameter too', () => {
    expect(hide('https://api.example.com/x;token=v1')).toBe('https://api.example.com/x;token=<redacted>')
  })
})

describe('headers', () => {
  it('shows 20 request headers and counts the rest as keys', () => {
    const headers = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`X-H${String(index).padStart(2, '0')}`, 'v']))
    const out = JSON.parse(plain({ headers })) as { headers: Record<string, string> }
    expect(Object.keys(out.headers)).toHaveLength(21)
    expect(out.headers['X-H19']).toBe('<redacted>')
    expect(out.headers['X-H20']).toBeUndefined()
    expect(out.headers['…']).toBe('5 more keys')
  })

  it('drops a single response header that is not kept, and says so', () => {
    expect(plain({ headers: { 'content-type': 'text/plain', server: 'x' } }, { responseHeaders: true })).toBe('{"headers":{"content-type":"text/plain","…":"1 more headers dropped"}}')
  })

  it('hides an allowed header whose value is not a string', () => {
    expect(plain({ headers: { 'content-type': 5, accept: ['a'] } })).toBe('{"headers":{"content-type":"<redacted>","accept":"<redacted>"}}')
    expect(plain({ headers: { 'content-type': 5 } }, { responseHeaders: true })).toBe('{"headers":{"content-type":"<redacted>"}}')
  })

  it('treats the headers of a response as response headers at the top level of the output only', () => {
    expect(plain({ body: { headers: { 'x-forwarded': 'v', 'content-type': 'text/plain' } } }, { responseHeaders: true })).toBe('{"body":{"headers":{"x-forwarded":"<redacted>","content-type":"text/plain"}}}')
    expect(plain({ headers: { 'x-forwarded': 'v', 'content-type': 'text/plain' } })).toBe('{"headers":{"x-forwarded":"<redacted>","content-type":"text/plain"}}')
  })
})

describe('the secret inside the marker and the minimum piece', () => {
  it('does not replace again what a secret replaced before, even when the secret is part of the marker', () => {
    const redactor = createRedactor(['ecre'])
    expect(redactor.string('x ecre y')).toBe('x <secret> y')
    expect(redactor.seal(redactor.string('x ecre y'))).toBe('x <secret> y')
  })

  it('replaces a base64 piece of 8 characters and leaves one of 7', () => {
    const encoded = (secret: string): string => Buffer.from(`b${secret}tail`).toString('base64')
    const seven = encoded('abcdefg')
    expect(hide(`got ${seven} end`, ['abcdefg'])).toContain('<secret>')
    const six = encoded('abcdef')
    expect(hide(`got ${six} end`, ['abcdef'])).toBe(`got ${six} end`)
  })
})

describe('the forms of a secret that has plus and slash in its base64', () => {
  const secret = 'ab>>>???cd'
  const padded = Buffer.from(secret).toString('base64')
  const bare = padded.replace(/=+$/, '')
  const urlSafe = (text: string): string => text.replaceAll('+', '-').replaceAll('/', '_')

  it('has the characters that tell the alphabets apart', () => {
    expect(bare).toMatch(/\+/)
    expect(bare).toMatch(/\//)
    expect(padded).toMatch(/==$/)
  })

  it.each([
    ['padded', padded],
    ['unpadded', bare],
    ['url safe and padded', urlSafe(padded)],
    ['url safe and unpadded', urlSafe(bare)],
    ['hex', Buffer.from(secret).toString('hex')],
    ['upper-case hex', Buffer.from(secret).toString('hex').toUpperCase()],
  ])('replaces the %s form as a whole', (_name, form) => {
    expect(hide(`got ${form} here`, [secret])).toBe('got <secret> here')
  })
})

function pureSpan(lead: number, bytes: number): { from: number; to: number } {
  return { from: Math.ceil((lead * 8) / 6), to: Math.floor(((lead + bytes) * 8 - 6) / 6) }
}

describe('a secret inside the base64 of a longer value', () => {
  const secret = 'ab>>>???cd'
  const prefixes = ['', 'b', 'bb', 'user:', 'bbbb']
  const tails = ['', 'q', 'qz', 'tail']

  it.each([
    ['base64', (bytes: Buffer) => bytes.toString('base64')],
    ['base64url', (bytes: Buffer) => bytes.toString('base64url')],
  ])('replaces exactly the characters that depend on the secret alone, in %s', (_name, encode) => {
    for (const prefix of prefixes) {
      for (const tail of tails) {
        const echoed = encode(Buffer.from(`${prefix}${secret}${tail}`))
        const { from, to } = pureSpan(prefix.length, secret.length)
        const expected = prefix === '' && tail === '' ? '<secret>' : `${echoed.slice(0, from)}<secret>${echoed.slice(to + 1)}`
        expect(hide(`got ${echoed} here`, [secret]), JSON.stringify([prefix, tail])).toBe(`got ${expected} here`)
      }
    }
  })
})

describe('credentials in text', () => {
  it('leaves a value of 7 characters and hides one of 8 after a credential word', () => {
    expect(hide('token: Abcdef1 and token: Abcdef12')).toBe('token: Abcdef1 and token: <redacted>')
    expect(hide('Bearer Abcdef1 and Bearer Abcdef12')).toBe('Bearer Abcdef1 and Bearer <redacted>')
  })

  it('hides a value of capitals only, which has no digit', () => {
    expect(hide('secret: ABCDEFGHIJ and secret: abcdefghij')).toBe('secret: <redacted> and secret: abcdefghij')
    expect(hide('Bearer ABCDEFGHIJ')).toBe('Bearer <redacted>')
  })

  it.each([
    ['access_token=Abcdef123456', 'access_token=<redacted>'],
    ['client_secret: Abcdef123456', 'client_secret: <redacted>'],
    ['api-key = Abcdef123456', 'api-key = <redacted>'],
    ['private_key=MIIEvAIBADANBgkq', 'private_key=<redacted>'],
    ['signature=Abcdef123456', 'signature=<redacted>'],
    ['credential=Abcdef123456', 'credential=<redacted>'],
    ['access-key: AKIAIOSFODNN7EXAMPLE', 'access-key: <redacted>'],
    ['password=Abcdef123456', 'password=<redacted>'],
    ['passwd=Abcdef123456', 'passwd=<redacted>'],
    ['pwd=Abcdef123456', 'pwd=<redacted>'],
    ['tokenValue=Abcdef123456', 'tokenValue=<redacted>'],
    ['client_secret_id: Abcdef123456', 'client_secret_id: <redacted>'],
    ['"token":"Abcdef123456"', '"token":"<redacted>"'],
  ])('hides the value in %s', (text, expected) => {
    expect(hide(text)).toBe(expected)
  })

  it('stops a cookie value at a quote', () => {
    expect(hide('got {"Cookie":"sid=abc123","next":"keep"}')).toBe('got {"Cookie":"<redacted>","next":"keep"}')
  })

  it('hides the value of a header whose name is followed by a scheme', () => {
    expect(hide('x-api-key: Bearer abc123 and Authorization=Basic xyz789 done')).toBe('x-api-key: <redacted> and Authorization=<redacted> done')
    expect(hide('proxy-authorization: abc123')).toBe('proxy-authorization: <redacted>')
    expect(hide('X-Auth-Token: t-2, X-Access-Token: t-3, X-CSRF-Token: t-4')).toBe('X-Auth-Token: <redacted>, X-Access-Token: <redacted>, X-CSRF-Token: <redacted>')
  })
})

describe('binary text', () => {
  const base64 = (length: number): string => 'QUJD'.repeat(Math.ceil(length / 4)).slice(0, length)

  it('is taken for binary from 200 characters, not before', () => {
    expect(plain({ a: base64(199) })).toBe(`{"a":"${base64(199)}"}`)
    expect(plain({ a: base64(200) })).toBe('{"a":"<binary 200 chars>"}')
    expect(plain({ a: base64(201) })).toBe('{"a":"<binary 201 chars>"}')
  })

  it('is taken for binary in the url safe alphabet and for a data URL of any length of header', () => {
    expect(plain({ a: `${'-_'.repeat(100)}` })).toBe('{"a":"<binary 200 chars>"}')
    expect(plain({ a: 'data:image/png;base64,QUJD' })).toBe('{"a":"<binary 26 chars>"}')
    expect(plain({ a: `data:${'x'.repeat(100)},QUJD` })).toBe('{"a":"<binary 110 chars>"}')
    expect(plain({ a: `data:${'x'.repeat(101)},QUJD` })).not.toContain('<binary')
  })

  it('is judged after the secrets were replaced, so a replaced secret is shown as text', () => {
    const secret = 'ABCDEFGHIJKL'
    const text = `${base64(100)}${secret}${base64(100)}`
    const shown = excerpt({ a: text }, createRedactor([secret]))
    expect(shown).not.toContain('<binary')
    expect(shown).toContain('<secret>')
  })

  it('counts the characters beyond the window of a string that is cut', () => {
    const shown = plain({ a: 'x '.repeat(524_289) })
    expect(shown).toBe(`{"a":"${'x '.repeat(100)}… 1048378 more characters"}`.replace('1048378', String('x '.repeat(524_289).length - 200)))
  })
})

describe('markers of what was left out', () => {
  it('says one more item and one more key', () => {
    expect(plain({ a: [1, 2, 3, 4, 5, 6] })).toBe('{"a":[1,2,3,4,5,"… 1 more"]}')
    const keys = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, index]))
    expect(JSON.parse(plain(keys))['…']).toBe('1 more keys')
  })
})

describe('the work budget of one excerpt', () => {
  const entries = (text: string): number => (text.match(/"[a-z]{2}":"x{190}"/g) ?? []).length
  const keysOf = (): string[] => {
    const letters = 'abcdefghij'
    return Array.from({ length: 20 }, (_, index) => `${letters[index % 10]}${letters[Math.floor(index / 10)]}`)
  }

  it('stops after 30 entries of 200 characters, counting the key and the string, in objects', () => {
    const object = Object.fromEntries(keysOf().map((key) => [key, 'x'.repeat(190)]))
    expect(entries(plain({ list: [object, object, object, object, object] }))).toBe(30)
  })

  it('stops after 31 strings of 190 characters in arrays that nest', () => {
    const leaves = (depth: number): unknown => (depth === 0 ? ['x'.repeat(190), 'x'.repeat(190), 'x'.repeat(190), 'x'.repeat(190), 'x'.repeat(190)] : [leaves(depth - 1), leaves(depth - 1), leaves(depth - 1), leaves(depth - 1), leaves(depth - 1)])
    expect((plain(leaves(3)).match(/x{190}/g) ?? []).length).toBe(31)
  })

  it('counts a key by its length', () => {
    const long = 'k'.repeat(96)
    const object = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${long}${String(index).padStart(2, '0')}`, 'x'.repeat(40)]))
    const shown = (plain({ l: [object, object, object, object, object] }).match(/"k{96}\d\d":"x{40}"/g) ?? []).length
    expect(shown).toBe(Math.ceil((6000 - 'l'.length - 4) / (98 + 4 + 44)))
  })
})
