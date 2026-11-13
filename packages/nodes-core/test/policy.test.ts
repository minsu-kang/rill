import { describe, expect, it } from 'vitest'
import { hostCheckFor, hostMatches, hostOfUrl, isEmptyPolicy, judgeConfigUrl, judgeUrl } from '../src/index'

const PATTERNS = ['api.example.com', '*.example.org', '127.0.0.1', '[::1]', 'xn--bcher-kva.de']

const HOSTS: Array<[host: string, allowed: boolean]> = [
  ['api.example.com', true],
  ['a.example.org', true],
  ['a.b.example.org', true],
  ['evilapi.example.org', true],
  ['127.0.0.1', true],
  ['[::1]', true],
  ['xn--bcher-kva.de', true],
  ['example.org', false],
  ['xexample.org', false],
  ['evil-example.org', false],
  ['example.org.evil.com', false],
  ['evilapi.example.com', false],
  ['api.example.com.evil.com', false],
  ['sub.api.example.com', false],
  ['127.0.0.2', false],
  ['[::2]', false],
  ['localhost', false],
  ['example.com', false],
]

const SCHEMES = ['http', 'https', 'HTTP', 'HtTpS']
const USER_INFO = ['', 'user@', 'user:pw@', 'allowed.com@', 'a%40b@', ':@']
const PORTS = ['', ':80', ':443', ':8443', ':65535']
const TAILS = ['', '/', '/a/b', '/a?x=1', '/a?h=evil.com', '/a#frag', '?q=1', '#f', '/%2e%2e/x', '/?@evil.com', '/#@evil.com']

function spellings(host: string): string[] {
  const forms = [host, host.toUpperCase()]
  if (!host.startsWith('[') && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) forms.push(`${host}.`)
  return forms
}

function* generated(host: string): Generator<string> {
  for (const scheme of SCHEMES) {
    for (const info of USER_INFO) {
      for (const form of spellings(host)) {
        for (const port of PORTS) {
          for (const tail of TAILS) yield `${scheme}://${info}${form}${port}${tail}`
        }
      }
    }
  }
}

describe('hostOfUrl', () => {
  it('reads the real host of a URL: lower case, without user info, port, path, query or fragment', () => {
    expect(hostOfUrl('https://User:Pw@API.Example.com:8443/a/b?x=1#f')).toBe('api.example.com')
  })

  it('removes one trailing dot and refuses more', () => {
    expect(hostOfUrl('https://api.example.com./')).toBe('api.example.com')
    expect(hostOfUrl('https://api.example.com../')).toBeUndefined()
    expect(hostOfUrl('https://a..example.com/')).toBeUndefined()
    expect(hostOfUrl('https://.example.com/')).toBeUndefined()
  })

  it('converts an internationalised name to punycode', () => {
    expect(hostOfUrl('https://bücher.de/')).toBe('xn--bcher-kva.de')
    expect(hostOfUrl('https://BÜCHER.DE/')).toBe('xn--bcher-kva.de')
  })

  it('writes an address in its canonical form', () => {
    expect(hostOfUrl('http://2130706433/')).toBe('127.0.0.1')
    expect(hostOfUrl('http://0x7f.1/')).toBe('127.0.0.1')
    expect(hostOfUrl('http://[0:0:0:0:0:0:0:1]:80/')).toBe('[::1]')
  })

  it('returns nothing for a URL it cannot parse, with a scheme other than http or https, or without a scheme', () => {
    for (const url of ['', 'allowed.com', '//allowed.com/', 'ftp://allowed.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://allowed.com:99999/', 'https://[::1/', 'https://a b.com/', 'https://%00.com/']) {
      expect(hostOfUrl(url), url).toBeUndefined()
    }
  })
})

describe('hostMatches', () => {
  it('matches an exact host only exactly', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true)
    expect(hostMatches('a.api.example.com', 'api.example.com')).toBe(false)
    expect(hostMatches('xapi.example.com', 'api.example.com')).toBe(false)
  })

  it('matches a wildcard against every subdomain and never the apex', () => {
    expect(hostMatches('a.example.com', '*.example.com')).toBe(true)
    expect(hostMatches('a.b.example.com', '*.example.com')).toBe(true)
    expect(hostMatches('example.com', '*.example.com')).toBe(false)
    expect(hostMatches('.example.com', '*.example.com')).toBe(false)
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false)
    expect(hostMatches('a.example.com.evil.com', '*.example.com')).toBe(false)
  })

  it('never lets a wildcard match an address', () => {
    expect(hostMatches('127.0.0.1', '*.0.0.1')).toBe(false)
    expect(hostMatches('[::1]', '*.::1]')).toBe(false)
  })

  it('treats a pattern as case-insensitive', () => {
    expect(hostMatches('api.example.com', 'API.Example.COM')).toBe(true)
  })
})

describe('judgeUrl', () => {
  it('names the host that is not allowed', () => {
    expect(judgeUrl('https://evil.com/x', PATTERNS)).toEqual({ ok: false, reason: 'not_allowed', host: 'evil.com' })
    expect(judgeUrl('https://api.example.com/x', PATTERNS)).toEqual({ ok: true, host: 'api.example.com' })
  })

  it('says invalid for a URL it cannot judge', () => {
    expect(judgeUrl('not a url', PATTERNS)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('allows nothing when there are no patterns', () => {
    expect(judgeUrl('https://api.example.com/x', []).ok).toBe(false)
  })
})

describe('host matching over generated URL forms', () => {
  it.each(HOSTS)('judges every form of %s as the host says (%s)', (host, allowed) => {
    let count = 0
    for (const url of generated(host)) {
      count += 1
      const judged = judgeUrl(url, PATTERNS)
      if (judged.ok !== allowed) throw new Error(`${url}: expected ${allowed ? 'allowed' : 'refused'}`)
      if (allowed && judged.ok) expect(judged.host).toBe(host)
    }
    expect(count).toBeGreaterThan(2000)
  })

  it('judges the same through the check the context gets', () => {
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts: PATTERNS })!
    for (const [host, allowed] of HOSTS) {
      for (const url of [`https://${host}/`, `http://user@${host.toUpperCase()}:8080/p?q#f`]) expect(check(url), url).toBe(allowed)
    }
  })
})

describe('the tricky URLs of the rules', () => {
  const patterns = ['allowed.com']
  const cases: Array<[string, boolean, string]> = [
    ['https://allowed.com/', true, 'a plain URL'],
    ['https://ALLOWED.COM/', true, 'upper case'],
    ['HTTPS://allowed.com', true, 'an upper case scheme'],
    ['https://allowed.com./', true, 'a trailing dot'],
    ['https://allowed.com:8080/', true, 'an explicit port'],
    ['https://allowed.com/#frag', true, 'a fragment'],
    ['https://allowed.com#@evil.com/', true, 'an at sign in the fragment'],
    ['https://allowed.com?@evil.com/', true, 'an at sign in the query'],
    ['https://evil.com:80@allowed.com/', true, 'user info that names another host'],
    ['https://allowed.com\\@evil.com/', true, 'a backslash that ends the host'],
    ['https://ａｌｌｏｗｅｄ.com/', true, 'full-width letters that map to the host'],
    ['https://allowed.com@evil.com/', false, 'the allowed host as user info'],
    ['https://allowed.com:80@evil.com:80/', false, 'the allowed host as user info with ports'],
    ['https://allowed.com.evil.com/', false, 'the allowed host as a prefix'],
    ['https://evil.com/?h=allowed.com', false, 'the allowed host in the query'],
    ['https://evil.com/#allowed.com', false, 'the allowed host in the fragment'],
    ['https://evil.com/allowed.com', false, 'the allowed host in the path'],
    ['https://evil.com\\@allowed.com/', false, 'a backslash before the at sign'],
    ['https://allowed.com%2eevil.com/', false, 'a percent-encoded dot'],
    ['https://allowed.com。evil.com/', false, 'an ideographic full stop'],
    ['https://allowed.com\t.evil.com/', false, 'a tab inside the host'],
    ['https://allowed.com%00.evil.com/', false, 'an encoded NUL'],
    ['https://allowed.com../', false, 'two trailing dots'],
    ['https://allowed.com:99999/', false, 'a port out of range'],
    ['https:allowed.com@evil.com', false, 'a scheme without slashes'],
    ['https://evil.com/\u0000.allowed.com', false, 'a NUL in the path'],
    ['https://notallowed.com/', false, 'a longer host'],
    ['https://sub.allowed.com/', false, 'a subdomain of an exact host'],
    ['ftp://allowed.com/', false, 'another scheme'],
    ['file:///etc/passwd', false, 'a file URL'],
    ['javascript:alert(1)', false, 'a script URL'],
    ['//allowed.com/', false, 'a scheme-relative URL'],
    ['allowed.com', false, 'no scheme'],
    ['', false, 'an empty URL'],
  ]
  it.each(cases)('%s is judged %s (%s)', (url, allowed) => {
    expect(judgeUrl(url, patterns).ok).toBe(allowed)
  })

  it('judges an internationalised name by its punycode form, both ways', () => {
    expect(judgeUrl('https://bücher.de/', ['xn--bcher-kva.de']).ok).toBe(true)
    expect(judgeUrl('https://xn--bcher-kva.de/', ['xn--bcher-kva.de']).ok).toBe(true)
    expect(judgeUrl('https://buecher.de/', ['xn--bcher-kva.de']).ok).toBe(false)
  })

  it('judges every spelling of an address as the address', () => {
    for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://127.0.0.1:3000/x']) {
      expect(judgeUrl(url, ['127.0.0.1']).ok, url).toBe(true)
      expect(judgeUrl(url, ['127.0.0.2']).ok, url).toBe(false)
    }
    for (const url of ['http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::1]:8080/x']) {
      expect(judgeUrl(url, ['[::1]']).ok, url).toBe(true)
      expect(judgeUrl(url, ['127.0.0.1']).ok, url).toBe(false)
    }
  })

  it('does not let a wildcard rule allow an address, nor a name rule allow an address of the same digits', () => {
    expect(judgeUrl('http://127.0.0.1/', ['*.0.0.1']).ok).toBe(false)
    expect(judgeUrl('http://[::1]/', ['*.example.com']).ok).toBe(false)
  })

  it('refuses a host with an empty part, also behind a wildcard', () => {
    expect(judgeUrl('https://x..example.org/', ['*.example.org']).ok).toBe(false)
    expect(judgeUrl('https://..example.org/', ['*.example.org']).ok).toBe(false)
    expect(judgeUrl('https://a..b.com/', ['a..b.com']).ok).toBe(false)
  })

  it('refuses a URL that merely contains an allowed wildcard host', () => {
    expect(judgeUrl('https://example.org/', ['*.example.org']).ok).toBe(false)
    expect(judgeUrl('https://evil.com/.example.org', ['*.example.org']).ok).toBe(false)
    expect(judgeUrl('https://a.example.org@evil.com/', ['*.example.org']).ok).toBe(false)
  })
})

describe('judgeConfigUrl', () => {
  const patterns = ['api.example.com']

  it('judges a literal URL like judgeUrl', () => {
    expect(judgeConfigUrl('https://api.example.com/v1', patterns)).toEqual({ ok: true, host: 'api.example.com' })
    expect(judgeConfigUrl('https://evil.com/v1', patterns)).toEqual({ ok: false, reason: 'not_allowed', host: 'evil.com' })
    expect(judgeConfigUrl('nope', patterns)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('allows a reference in the path, the query or the fragment', () => {
    for (const url of [
      'https://api.example.com/{{t1.output.id}}',
      'https://api.example.com/v1/{{t1.output.id}}/items?x={{n1.output.y}}',
      'https://api.example.com/?id={{t1.output.id}}&k={{t1.output.k}}',
      'https://api.example.com/x#{{t1.output.f}}',
      'https://api.example.com/{{t1.output.a}}{{t1.output.b}}',
    ]) {
      expect(judgeConfigUrl(url, patterns).ok, url).toBe(true)
    }
  })

  it('still refuses a host that is not allowed when the reference sits in the path', () => {
    expect(judgeConfigUrl('https://evil.com/{{t1.output.id}}', patterns)).toEqual({ ok: false, reason: 'not_allowed', host: 'evil.com' })
  })

  it('refuses a reference in the scheme or the host part, because the host is only known at run time', () => {
    for (const url of [
      '{{t1.output.url}}',
      '{{t1.output.base}}/v1',
      '{{t1.output.scheme}}://api.example.com/',
      'ht{{t1.output.x}}ps://api.example.com/',
      'https://{{t1.output.host}}/v1',
      'https://api.{{t1.output.domain}}/v1',
      'https://{{t1.output.sub}}.example.com/',
      'https://api.example.com{{t1.output.tail}}/v1',
      'https://user:{{t1.output.pw}}@api.example.com/',
      'https://api.example.com:{{t1.output.port}}/v1',
      'https://{{t1.output.a}}@api.example.com/',
    ]) {
      expect(judgeConfigUrl(url, patterns), url).toEqual({ ok: false, reason: 'template' })
    }
  })

  it('refuses a reference that the URL parser reads as the host after extra slashes or a backslash', () => {
    for (const url of [
      'https:///{{t1.output.h}}.example.com/p',
      'https://\\{{t1.output.h}}.example.com/p',
      'https:////{{t1.output.h}}/',
      'https:\\\\{{t1.output.h}}.example.com/p',
      'https:/\\/{{t1.output.h}}.example.com/p',
      'https:///{{t1.output.h}}',
      'HTTPS:///{{t1.output.h}}.EXAMPLE.com/',
    ]) {
      expect(judgeConfigUrl(url, ['*.example.com', 'api.example.com']), url).toEqual({ ok: false, reason: 'template' })
    }
  })

  it('judges the real host when extra slashes come before a literal host', () => {
    expect(judgeConfigUrl('https:///api.example.com/{{t1.output.id}}', patterns)).toEqual({ ok: true, host: 'api.example.com' })
    expect(judgeConfigUrl('https://\\api.example.com/{{t1.output.id}}', patterns)).toEqual({ ok: true, host: 'api.example.com' })
    expect(judgeConfigUrl('https:///evil.com/{{t1.output.id}}', patterns)).toEqual({ ok: false, reason: 'not_allowed', host: 'evil.com' })
  })

  it('refuses a reference next to a name that is converted to punycode', () => {
    expect(judgeConfigUrl('https://bücher{{t1.output.h}}.de/', ['*.de'])).toEqual({ ok: false, reason: 'template' })
  })

  it('does not let a literal that looks like a placeholder change the verdict', () => {
    expect(judgeConfigUrl('https://rillref0q.example.com/{{t1.output.a}}', ['rillref0q.example.com'])).toEqual({ ok: true, host: 'rillref0q.example.com' })
    expect(judgeConfigUrl('https://RILLREF1Q.example.com/{{t1.output.a}}', ['rillref1q.example.com'])).toEqual({ ok: true, host: 'rillref1q.example.com' })
  })

  it('says invalid for a URL that has a reference only after the host but no scheme', () => {
    expect(judgeConfigUrl('api.example.com/{{t1.output.id}}', patterns)).toEqual({ ok: false, reason: 'invalid' })
    expect(judgeConfigUrl('ftp://api.example.com/{{t1.output.id}}', patterns)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('judges a malformed template by the URL parser, which refuses a brace in the host', () => {
    expect(judgeConfigUrl('https://{{bad/x', patterns).ok).toBe(false)
    expect(judgeConfigUrl('https://api.example.com/{{t1.output', patterns).ok).toBe(true)
  })
})

describe('isEmptyPolicy and hostCheckFor', () => {
  it('treat no policy and empty lists alike', () => {
    expect(isEmptyPolicy(undefined)).toBe(true)
    expect(isEmptyPolicy({ forbiddenNodes: [], allowedHosts: [] })).toBe(true)
    expect(isEmptyPolicy({ forbiddenNodes: ['http.request'], allowedHosts: [] })).toBe(false)
    expect(isEmptyPolicy({ forbiddenNodes: [], allowedHosts: ['a.com'] })).toBe(false)
  })

  it('gives no host check unless there is an allowed host', () => {
    expect(hostCheckFor(undefined)).toBeUndefined()
    expect(hostCheckFor({ forbiddenNodes: [], allowedHosts: [] })).toBeUndefined()
    expect(hostCheckFor({ forbiddenNodes: ['http.request'], allowedHosts: [] })).toBeUndefined()
    expect(hostCheckFor({ forbiddenNodes: [], allowedHosts: ['a.com'] })).toBeTypeOf('function')
  })

  it('takes a copy of the patterns, so a later change of the list does not change the check', () => {
    const allowedHosts = ['a.com']
    const check = hostCheckFor({ forbiddenNodes: [], allowedHosts })!
    allowedHosts.push('b.com')
    expect(check('https://b.com/')).toBe(false)
  })
})
