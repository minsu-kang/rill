import { maskSecretParts } from './connection-auth'
import { httpCall } from './http'
import { parseSlackSecret, slackSecretParts } from './slack-connection'
import { RetryableError } from './types'

export const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage'

const ERROR_CODE = /^[a-z_]{1,64}$/
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])
const HTTP_STATUS = /^HTTP \d{3}\b/

export type SlackFailure = 'connection' | 'timeout' | 'http_status' | 'slack_error' | 'unknown'

export interface SlackPostInput {
  secret: string
  text: string
  channel?: string | undefined
  timeoutMs: number
  signal?: AbortSignal | undefined
}

export type SlackPostResult = { ok: true; status: number } | { ok: false; failure: SlackFailure; error: Error }

function slackAnswer(body: unknown): { ok: boolean; error?: unknown } | undefined {
  let value = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { ok, error } = value as { ok?: unknown; error?: unknown }
  return typeof ok === 'boolean' ? { ok, error } : undefined
}

function refused(message: string): SlackPostResult {
  return { ok: false, failure: 'connection', error: new Error(message) }
}

function isTimeout(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'TimeoutError'
}

function transportFailure(error: unknown): SlackPostResult {
  const failure: Error = error instanceof Error ? error : new Error(String(error))
  if (HTTP_STATUS.test(failure.message)) return { ok: false, failure: 'http_status', error: failure }
  if (failure instanceof RetryableError && isTimeout(failure.cause)) return { ok: false, failure: 'timeout', error: failure }
  return { ok: false, failure: 'unknown', error: failure }
}

export async function postSlackMessage(input: SlackPostInput): Promise<SlackPostResult> {
  const parsed = parseSlackSecret(input.secret)
  if (parsed.kind === 'malformed') return refused('the Slack connection is not a webhook URL or a bot token')
  const signal = input.signal === undefined ? {} : { signal: input.signal }
  if (parsed.kind === 'webhook') {
    if (input.channel !== undefined) {
      return refused('this Slack connection is a webhook URL and posts to its own channel; remove the channel of this step or use a bot token connection')
    }
    try {
      const result = await httpCall(parsed.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.text }),
        timeoutMs: input.timeoutMs,
        ...signal,
      })
      return { ok: true, status: result.status }
    } catch (error) {
      return transportFailure(error)
    }
  }
  const channel = input.channel ?? parsed.channel
  if (channel === undefined) return refused('no Slack channel: set the channel of this step or give the connection a default channel')
  const hidden = slackSecretParts(input.secret)
  let result: Awaited<ReturnType<typeof httpCall>>
  try {
    result = await httpCall(SLACK_POST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${parsed.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text: input.text }),
      timeoutMs: input.timeoutMs,
      redact: (text) => maskSecretParts(text, hidden),
      ...signal,
    })
  } catch (error) {
    return transportFailure(error)
  }
  const answer = slackAnswer(result.body)
  if (answer === undefined) return { ok: false, failure: 'slack_error', error: new Error('Slack: unexpected_response') }
  if (!answer.ok) {
    const code = typeof answer.error === 'string' && ERROR_CODE.test(answer.error) ? answer.error : 'unknown_error'
    const message = `Slack: ${code}`
    return { ok: false, failure: 'slack_error', error: RETRYABLE_CODES.has(code) ? new RetryableError(message) : new Error(message) }
  }
  return { ok: true, status: result.status }
}
