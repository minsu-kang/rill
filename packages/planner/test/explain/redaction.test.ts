import { describe, expect, it } from 'vitest'
import { buildRunDigest } from '../../src/index'
import { SECRET, chain, edge, inputOf, node, runOf, step, workflowOf } from './helpers'

const textOf = (overrides: Parameters<typeof inputOf>[0]): string => buildRunDigest(inputOf(overrides)).text

describe('connection secrets', () => {
  const secrets = [SECRET, 'zx81-hunter']

  it('are replaced in a value, a key, a nested array and a string that merely contains them', () => {
    const text = textOf({
      secrets,
      steps: [
        step('n1', 'failed', {
          error: `HTTP 401: bad credential ${SECRET} rejected`,
          input: { plain: SECRET, 'id-zx81-hunter': 1, nested: { list: ['a', [SECRET], { deeper: `prefix ${SECRET} suffix` }] } },
          output: { echoed: `Bearer ${SECRET}` },
        }),
      ],
    })
    expect(text).not.toContain(SECRET)
    expect(text).toContain('HTTP 401: bad credential <secret> rejected')
    expect(text).toContain('"plain":"<secret>"')
    expect(text).toContain('"id-<secret>":1')
    expect(text).toContain('"list":["a",["<secret>"],{"deeper":"prefix <secret> suffix"}]')
  })

  it('are replaced in the run error, the workflow name and the workflow config', () => {
    const workflow = workflowOf(
      [node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: `https://api.example.com/${SECRET}/orders` })],
      [edge('t1', 'n1')],
      `Sync ${SECRET}`,
    )
    const text = textOf({ secrets, workflow, run: runOf({ error: `node n1 failed: ${SECRET}` }) })
    expect(text).not.toContain(SECRET)
    expect(text.match(/<secret>/g)).toHaveLength(3)
  })

  it('are replaced everywhere they occur, in every encoding a server is likely to echo', () => {
    const secret = 'p@ss"word/1234'
    const encodings = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
    const text = textOf({ secrets: [secret], steps: [step('n1', 'failed', { error: encodings.join(' | '), output: { a: encodings[0], b: encodings[1], c: encodings[2], d: encodings[3] } })] })
    for (const form of encodings) expect(text).not.toContain(form)
    expect(text).toContain('<secret> | <secret> | <secret> | <secret>')
  })

  it('are replaced before a long string is cut, so no piece of them survives the cut', () => {
    const secret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    for (const lead of [150, 170, 185, 195, 199, 200]) {
      const text = textOf({ secrets: [secret], steps: [step('n1', 'failed', { input: { body: `${'.'.repeat(lead)}${secret}${'.'.repeat(400)}` } })] })
      expect(text, `lead ${lead}`).not.toMatch(/ABCD|WXYZ|0123/)
    }
  })

  it('leave no piece when a cut lands inside a secret that fills the whole string', () => {
    const secret = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const text = textOf({ secrets: [secret], steps: [step('n1', 'failed', { input: { body: secret.repeat(40) } })] })
    expect(text).not.toMatch(/ABCD|MNOP|0123/)
  })

  it('ignore a value shorter than four characters', () => {
    const text = textOf({ secrets: ['abc', ''], steps: [step('n1', 'failed', { error: 'abc and abcd' })] })
    expect(text).toContain('error: abc and abcd')
    expect(text).not.toContain('<secret>')
  })

  it('replace the longer secret first when one contains the other', () => {
    const text = textOf({ secrets: ['TOKEN', 'TOKEN-LONGER-VALUE'], steps: [step('n1', 'failed', { error: 'x TOKEN-LONGER-VALUE y TOKEN z' })] })
    expect(text).toContain('error: x <secret> y <secret> z')
  })
})

describe('keys that look like credentials', () => {
  const keys = ['Authorization', 'cookie', 'Set-Cookie', 'token', 'access_token', 'refresh_token', 'secret', 'client_secret', 'password', 'passwd', 'api_key', 'apikey', 'api-key', 'X-Api-Key', 'bearer', 'session', 'sessionId', 'credentials']

  it.each(keys)('hide the value of %s at any depth of input, output and config', (key) => {
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'transform@1', { values: { [key]: 'CONFIG-VALUE-1' } })], [edge('t1', 'n1')])
    const text = textOf({
      workflow,
      steps: [step('n1', 'failed', { input: { [key]: 'INPUT-VALUE-2', deep: [{ [key]: 'DEEP-VALUE-3' }] }, output: { wrapper: { [key]: 'OUTPUT-VALUE-4' } } })],
    })
    expect(text).not.toMatch(/CONFIG-VALUE-1|INPUT-VALUE-2|DEEP-VALUE-3|OUTPUT-VALUE-4/)
    expect(text.match(/<redacted>/g)!.length).toBeGreaterThanOrEqual(4)
    expect(text).toContain(key.length > 0 ? key : '')
  })

  it('hide a value of any type, an object or an array included', () => {
    const text = textOf({ steps: [step('n1', 'failed', { input: { token: { a: 'OBJECT-VALUE' }, password: ['ARRAY-VALUE'], secret: 12345678, cookie: true } })] })
    expect(text).not.toMatch(/OBJECT-VALUE|ARRAY-VALUE|12345678/)
    expect(text).toContain('"token":"<redacted>"')
    expect(text).toContain('"password":"<redacted>"')
    expect(text).toContain('"secret":"<redacted>"')
    expect(text).toContain('"cookie":"<redacted>"')
  })

  it('keep a key that only looks a little like one', () => {
    const text = textOf({ steps: [step('n1', 'failed', { input: { amount: 12, title: 'Order', status: 'open' } })] })
    expect(text).toContain('{"amount":12,"title":"Order","status":"open"}')
  })
})

describe('request headers', () => {
  it('keep the value of content-type, accept and idempotency-key in config and input and hide every other value', () => {
    const headers = { 'Content-Type': 'application/json', Accept: 'text/csv', 'Idempotency-Key': 'run-1:n1', 'X-Custom': 'CUSTOM-VALUE', 'X-Tenant': 'TENANT-VALUE', Authorization: `Bearer ${SECRET}` }
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://api.example.com', headers })], [edge('t1', 'n1')])
    const text = textOf({ workflow, steps: [step('n1', 'failed', { input: { url: 'https://api.example.com', headers } })] })
    expect(text).not.toMatch(/CUSTOM-VALUE|TENANT-VALUE|SECRET-MARKER/)
    expect(text.match(/"Content-Type":"application\/json"/g)).toHaveLength(2)
    expect(text.match(/"Accept":"text\/csv"/g)).toHaveLength(2)
    expect(text.match(/"Idempotency-Key":"run-1:n1"/g)).toHaveLength(2)
    expect(text.match(/"X-Custom":"<redacted>"/g)).toHaveLength(2)
    expect(text.match(/"Authorization":"<redacted>"/g)).toHaveLength(2)
  })

  it('hide a headers value that is not an object', () => {
    const text = textOf({ steps: [step('n1', 'failed', { input: { headers: 'X-Custom: HEADER-LINE' } })] })
    expect(text).not.toContain('HEADER-LINE')
    expect(text).toContain('"headers":"<redacted>"')
  })

  it('hide the values of a headers object deeper in the data', () => {
    const text = textOf({ steps: [step('n1', 'failed', { output: { body: { echo: { headers: { 'X-Forwarded': 'FORWARDED-VALUE', 'content-type': 'text/plain' } } } } })] })
    expect(text).not.toContain('FORWARDED-VALUE')
    expect(text).toContain('"content-type":"text/plain"')
  })
})

describe('response headers of an http.request', () => {
  it('are dropped except content-type and retry-after', () => {
    const output = {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30', 'set-cookie': 'sid=COOKIE-VALUE', server: 'SERVER-VALUE', 'x-request-id': 'REQUEST-ID-VALUE', 'x-ratelimit-remaining': '0' },
      body: { error: 'slow down' },
    }
    const text = textOf({ steps: [step('n1', 'continued', { error: 'HTTP 429', output })] })
    expect(text).not.toMatch(/COOKIE-VALUE|SERVER-VALUE|REQUEST-ID-VALUE|x-ratelimit/)
    expect(text).toContain('"headers":{"content-type":"application/json","retry-after":"30","…":"4 more headers dropped"}')
    expect(text).toContain('"body":{"error":"slow down"}')
  })

  it('do not need a marker when nothing was dropped', () => {
    const text = textOf({ steps: [step('n1', 'continued', { error: 'HTTP 429', output: { status: 429, headers: { 'retry-after': '5' }, body: null } })] })
    expect(text).toContain('"headers":{"retry-after":"5"}')
  })

  it('apply to the output of an http.request only: another node keeps the generic header rule', () => {
    const text = textOf({
      workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'transform@1', { values: {} }), node('n2', 'http.request@1', { url: 'https://a.example.com' })], [edge('t1', 'n1'), edge('n1', 'n2')]),
      steps: [step('n1', 'failed', { output: { headers: { 'retry-after': '5', 'x-other': 'OTHER-VALUE' } } })],
    })
    expect(text).not.toContain('OTHER-VALUE')
    expect(text).toContain('"x-other":"<redacted>"')
  })
})

describe('credentials inside a URL', () => {
  it('hide user info and the value of a query parameter that looks like a credential', () => {
    const workflow = workflowOf(
      [node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://user:PASS-VALUE@api.example.com/v1?api_key=KEY-VALUE&page=2&sig=SIG-VALUE&access_token=TOKEN-VALUE' })],
      [edge('t1', 'n1')],
    )
    const text = textOf({ workflow })
    expect(text).not.toMatch(/PASS-VALUE|KEY-VALUE|SIG-VALUE|TOKEN-VALUE/)
    expect(text).toContain('https://<redacted>@api.example.com/v1?api_key=<redacted>&page=2&sig=<redacted>&access_token=<redacted>')
  })
})

describe('the excerpt of a step', () => {
  const text = (value: unknown): string => buildRunDigest(inputOf({ steps: [step('n1', 'failed', { input: value })] })).text

  const words = (length: number): string => 'ab '.repeat(Math.ceil(length / 3)).slice(0, length)

  it('keeps strings of 200 characters and cuts longer ones with a count', () => {
    expect(text({ s: words(200) })).toContain(`"s":"${words(200)}"`)
    const cut = text({ s: words(450) })
    expect(cut).toContain(`"s":"${words(200)}… 250 more characters"`)
  })

  it('keeps five array items and says how many more there are', () => {
    expect(text({ a: [1, 2, 3, 4, 5] })).toContain('"a":[1,2,3,4,5]')
    expect(text({ a: [1, 2, 3, 4, 5, 6, 7] })).toContain('"a":[1,2,3,4,5,"… 2 more"]')
  })

  it('keeps twenty object keys and says how many more there are', () => {
    const keys = Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`k${index}`, index]))
    const out = text(keys)
    expect(out).toContain('"k19":19')
    expect(out).not.toContain('"k20"')
    expect(out).toContain('"…":"3 more keys"')
  })

  it('goes four levels deep and summarises what is below', () => {
    const out = text({ l1: { l2: { l3: { l4: { l5: 'x' }, list: [1, 2] } } } })
    expect(out).toContain('{"l1":{"l2":{"l3":{"l4":"<object 1 keys>","list":"<array 2 items>"}}}}')
  })

  it('replaces base64-looking strings of 200 characters or more and data URLs with a size', () => {
    const base64 = 'QUJD'.repeat(100)
    const out = text({ file: base64, other: `${base64}==`, url: `data:image/png;base64,${base64}`, short: 'QUJD'.repeat(20) })
    expect(out).toContain('"file":"<binary 400 chars>"')
    expect(out).toContain('"other":"<binary 402 chars>"')
    expect(out).toContain(`"url":"<binary ${22 + 400} chars>"`)
    expect(out).toContain(`"short":"${'QUJD'.repeat(20)}"`)
  })

  it('does not take ordinary long text for binary', () => {
    expect(text({ s: `${'word '.repeat(60)}end` })).toContain('word word word')
  })

  it('limits input and output of one step to 1,500 characters together', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'v'.repeat(190)]))
    const full = buildRunDigest(inputOf({ steps: [step('n1', 'failed', { input: wide, output: wide })] })).text
    const input = full.split('\n').find((entry) => entry.startsWith('input: '))!
    const output = full.split('\n').find((entry) => entry.startsWith('output: '))!
    expect(input.length - 'input: '.length + output.length - 'output: '.length).toBeLessThanOrEqual(1500)
    expect(input).toMatch(/… \d+ more characters$/)
    expect(output).toMatch(/… \d+ more characters$/)
  })

  it('gives the unused part of the limit to the side that needs it', () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'v'.repeat(190)]))
    const full = buildRunDigest(inputOf({ steps: [step('n1', 'failed', { input: { small: 1 }, output: wide })] })).text
    const output = full.split('\n').find((entry) => entry.startsWith('output: '))!
    expect(output.length).toBeGreaterThan(1300)
    expect(full).toContain('input: {"small":1}')
  })

  it('prints null for a step without input or output', () => {
    const out = buildRunDigest(inputOf({ steps: [step('n1', 'skipped', { input: null, output: null })] })).text
    expect(out).toContain('input: null')
    expect(out).toContain('output: null')
  })
})

describe('the chain fixture', () => {
  it('is a plain workflow the other tests can lean on', () => {
    expect(chain().nodes.map((entry) => entry.id)).toEqual(['t1', 'n1', 'n2'])
  })
})
