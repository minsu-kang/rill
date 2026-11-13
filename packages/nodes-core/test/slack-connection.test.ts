import { describe, expect, it } from 'vitest'
import {
  SLACK_CHANNEL_MAX,
  connectionSecretParts,
  encodeConnectionSecret,
  encodeSlackBotSecret,
  isSlackBotSecret,
  isSlackChannel,
  isSlackToken,
  parseSlackSecret,
  slackSecretParts,
} from '../src/index'

const TOKEN = 'xoxb-SLACKTOKENMARKER0123'
const HOOK = 'https://hooks.slack.com/services/T000/B000/WEBHOOKMARKER'

describe('parseSlackSecret', () => {
  it('reads an https webhook url', () => {
    expect(parseSlackSecret(HOOK)).toEqual({ kind: 'webhook', url: HOOK })
  })

  it('keeps reading a plain http url as a webhook', () => {
    expect(parseSlackSecret('http://127.0.0.1:8080/hook')).toEqual({ kind: 'webhook', url: 'http://127.0.0.1:8080/hook' })
  })

  it('reads the structured form with and without a channel', () => {
    expect(parseSlackSecret(JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#alerts' }))).toEqual({ kind: 'bot', token: TOKEN, channel: '#alerts' })
    expect(parseSlackSecret(JSON.stringify({ rillSlack: 1, token: TOKEN }))).toEqual({ kind: 'bot', token: TOKEN })
  })

  it('tolerates blanks before the structured form', () => {
    expect(parseSlackSecret(`  \n${JSON.stringify({ rillSlack: 1, token: TOKEN })}`)).toEqual({ kind: 'bot', token: TOKEN })
  })

  it('reads a plain token as a bot connection without a channel', () => {
    expect(parseSlackSecret(TOKEN)).toEqual({ kind: 'bot', token: TOKEN })
  })

  it('round-trips through the encoder', () => {
    expect(parseSlackSecret(encodeSlackBotSecret({ token: TOKEN, channel: 'C0123ABCDEF' }))).toEqual({ kind: 'bot', token: TOKEN, channel: 'C0123ABCDEF' })
    expect(JSON.parse(encodeSlackBotSecret({ token: TOKEN }))).toEqual({ rillSlack: 1, token: TOKEN })
  })

  const malformed: Record<string, string> = {
    'an empty string': '',
    'a url without a scheme': 'hooks.slack.com/services/T000/B000/WEBHOOKMARKER',
    'an ftp url': 'ftp://hooks.slack.com/x',
    'a file url': 'file:///etc/passwd',
    'a javascript url': 'javascript:alert(1)',
    'a token with the wrong prefix': 'xoxp-SLACKTOKENMARKER0123',
    'a token that is too short': 'xoxb-short',
    'a token with a space': 'xoxb-SLACKTOKEN MARKER0123',
    'a token with a trailing newline': `${TOKEN}\n`,
    'a token of 201 characters after the prefix': `xoxb-${'a'.repeat(201)}`,
    'a bearer line': `Bearer ${TOKEN}`,
    'json without rillSlack': JSON.stringify({ token: TOKEN }),
    'a rillAuth secret': encodeConnectionSecret({ type: 'bearer', token: 'abcd1234' }),
    'an extra key': JSON.stringify({ rillSlack: 1, token: TOKEN, extra: true }),
    'a wrong rillSlack number': JSON.stringify({ rillSlack: 2, token: TOKEN }),
    'a wrong rillSlack type': JSON.stringify({ rillSlack: '1', token: TOKEN }),
    'a missing token': JSON.stringify({ rillSlack: 1 }),
    'a token that is not a string': JSON.stringify({ rillSlack: 1, token: 5 }),
    'a token with a bad pattern': JSON.stringify({ rillSlack: 1, token: 'xoxb-' }),
    'a channel that is not a string': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: 5 }),
    'an empty channel': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '' }),
    'a channel with a space': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#al erts' }),
    'a channel with a newline': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#al\nerts' }),
    'a channel with a control character': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#al\u0000erts' }),
    'a channel with a DEL': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#al\u007ferts' }),
    'a channel of 81 characters': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#'.padEnd(SLACK_CHANNEL_MAX + 1, 'a') }),
    'a channel with a lone surrogate': JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#a\uD800b' }),
    'an array': JSON.stringify([TOKEN]),
    'json that is cut': `{"rillSlack":1,"token":"${TOKEN}"`,
    'null': 'null',
  }
  for (const [label, secret] of Object.entries(malformed)) {
    it(`marks ${label} as malformed`, () => {
      expect(parseSlackSecret(secret)).toEqual({ kind: 'malformed' })
    })
  }

  it('accepts a channel of exactly 80 characters', () => {
    const channel = '#'.padEnd(SLACK_CHANNEL_MAX, 'a')
    expect(parseSlackSecret(JSON.stringify({ rillSlack: 1, token: TOKEN, channel }))).toEqual({ kind: 'bot', token: TOKEN, channel })
  })

  it('accepts the longest and the shortest token', () => {
    expect(isSlackToken(`xoxb-${'a'.repeat(200)}`)).toBe(true)
    expect(isSlackToken(`xoxb-${'a'.repeat(10)}`)).toBe(true)
    expect(isSlackToken(`xoxb-${'a'.repeat(9)}`)).toBe(false)
  })
})

describe('isSlackChannel', () => {
  it.each(['#alerts', 'C0123ABCDEF', '@someone', 'general', 'å'])('accepts %s', (channel) => {
    expect(isSlackChannel(channel)).toBe(true)
  })

  it.each(['', ' ', '# a', 'a\tb', 'a\u0085b', 5, undefined, null, 'x'.repeat(81)])('refuses %j', (channel) => {
    expect(isSlackChannel(channel)).toBe(false)
  })
})

describe('slackSecretParts and connectionSecretParts', () => {
  it('returns the token of a bot secret and nothing else', () => {
    expect(slackSecretParts(JSON.stringify({ rillSlack: 1, token: TOKEN, channel: '#alerts' }))).toEqual([TOKEN])
    expect(slackSecretParts(TOKEN)).toEqual([TOKEN])
  })

  it('returns nothing for a webhook or a malformed value', () => {
    expect(slackSecretParts(HOOK)).toEqual([])
    expect(slackSecretParts('{')).toEqual([])
    expect(slackSecretParts(JSON.stringify({ rillSlack: 1, token: TOKEN, extra: 1 }))).toEqual([])
  })

  it('covers both structured formats', () => {
    expect(connectionSecretParts(encodeSlackBotSecret({ token: TOKEN, channel: '#alerts' }))).toEqual([TOKEN])
    expect(connectionSecretParts(encodeConnectionSecret({ type: 'bearer', token: 'abcd1234' }))).toEqual(['abcd1234'])
    expect(connectionSecretParts(encodeConnectionSecret({ type: 'basic', username: 'u', password: 'pass1234' }))).toEqual(['pass1234', 'u:pass1234', Buffer.from('u:pass1234').toString('base64')])
    expect(connectionSecretParts(HOOK)).toEqual([])
    expect(connectionSecretParts('plain value')).toEqual([])
  })
})

describe('isSlackBotSecret', () => {
  it('recognises every bot form, valid or not', () => {
    expect(isSlackBotSecret(encodeSlackBotSecret({ token: TOKEN, channel: '#alerts' }))).toBe(true)
    expect(isSlackBotSecret(TOKEN)).toBe(true)
    expect(isSlackBotSecret(`\n ${encodeSlackBotSecret({ token: TOKEN })}`)).toBe(true)
    expect(isSlackBotSecret(JSON.stringify({ rillSlack: 2, token: TOKEN }))).toBe(true)
    expect(isSlackBotSecret(JSON.stringify({ rillSlack: 1, token: TOKEN, extra: 1 }))).toBe(true)
    expect(isSlackBotSecret(JSON.stringify({ rillSlack: 1 }))).toBe(true)
  })

  it('does not recognise a webhook, a rillAuth secret, other JSON or plain text', () => {
    expect(isSlackBotSecret(HOOK)).toBe(false)
    expect(isSlackBotSecret(encodeConnectionSecret({ type: 'bearer', token: 'abcd1234' }))).toBe(false)
    expect(isSlackBotSecret('{"a":1}')).toBe(false)
    expect(isSlackBotSecret('{')).toBe(false)
    expect(isSlackBotSecret('[1]')).toBe(false)
    expect(isSlackBotSecret('plain value')).toBe(false)
    expect(isSlackBotSecret('')).toBe(false)
  })
})
