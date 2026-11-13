export type SlackSecret =
  | { kind: 'webhook'; url: string }
  | { kind: 'bot'; token: string; channel?: string }
  | { kind: 'malformed' }

export const SLACK_TOKEN_PATTERN = /^xoxb-[A-Za-z0-9-]{10,200}$/
export const SLACK_CHANNEL_MAX = 80

const BLANK_OR_CONTROL = /[\s\p{Cc}]/u
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const LEADING_BLANK = /^\s+/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSlackToken(value: unknown): value is string {
  return typeof value === 'string' && SLACK_TOKEN_PATTERN.test(value)
}

export function isSlackChannel(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SLACK_CHANNEL_MAX && !BLANK_OR_CONTROL.test(value) && !LONE_SURROGATE.test(value)
}

function parseStructured(text: string): SlackSecret {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { kind: 'malformed' }
  }
  if (!isRecord(data) || data.rillSlack !== 1) return { kind: 'malformed' }
  if (!Object.keys(data).every((key) => key === 'rillSlack' || key === 'token' || key === 'channel')) return { kind: 'malformed' }
  if (!isSlackToken(data.token)) return { kind: 'malformed' }
  if (!('channel' in data)) return { kind: 'bot', token: data.token }
  return isSlackChannel(data.channel) ? { kind: 'bot', token: data.token, channel: data.channel } : { kind: 'malformed' }
}

export function parseSlackSecret(secret: string): SlackSecret {
  if (SLACK_TOKEN_PATTERN.test(secret)) return { kind: 'bot', token: secret }
  const trimmed = secret.replace(LEADING_BLANK, '')
  if (trimmed.startsWith('{')) return parseStructured(trimmed)
  try {
    const target = new URL(secret)
    if (target.protocol === 'https:' || target.protocol === 'http:') return { kind: 'webhook', url: secret }
  } catch {
    return { kind: 'malformed' }
  }
  return { kind: 'malformed' }
}

export function encodeSlackBotSecret(bot: { token: string; channel?: string }): string {
  return JSON.stringify({ rillSlack: 1, token: bot.token, ...(bot.channel === undefined ? {} : { channel: bot.channel }) })
}

export function slackSecretParts(secret: string): string[] {
  const parsed = parseSlackSecret(secret)
  return parsed.kind === 'bot' ? [parsed.token] : []
}

export function isSlackBotSecret(secret: string): boolean {
  if (parseSlackSecret(secret).kind === 'bot') return true
  try {
    const data: unknown = JSON.parse(secret.replace(LEADING_BLANK, ''))
    return isRecord(data) && 'rillSlack' in data
  } catch {
    return false
  }
}
