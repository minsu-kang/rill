import Type from 'typebox'
import { maskSecretParts } from '../connection-auth'
import { httpCall } from '../http'
import { SLACK_CHANNEL_MAX, parseSlackSecret, slackSecretParts } from '../slack-connection'
import { RetryableError, defineAction } from '../types'

const POST_URL = 'https://slack.com/api/chat.postMessage'
const ERROR_CODE = /^[a-z_]{1,64}$/
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])

function slackAnswer(body: unknown): { ok: boolean; error?: unknown } | undefined {
  let value = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { ok, error } = value as { ok?: unknown; error?: unknown }
  return typeof ok === 'boolean' ? { ok, error } : undefined
}

export const notifySlack = defineAction({
  type: 'notify.slack@1',
  title: 'Slack message',
  description:
    'Posts a message through a Slack webhook connection or a bot token connection. A crash right after sending can make a resumed run send it twice. A retry after a server error can do the same. The channel is read by a bot token connection only: leave it out unless the user named a channel, and never set it for a connection that the environment lists as a webhook. Without a channel the default channel of the connection is used.',
  sideEffect: 'external',
  roles: { '/connection': 'connection', '/channel': 'recipient', '/text': 'message' },
  configSchema: Type.Object(
    {
      connection: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1, maxLength: 3000 }),
      channel: Type.Optional(Type.String({ minLength: 1, maxLength: SLACK_CHANNEL_MAX })),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object({ sent: Type.Boolean(), status: Type.Integer() }),
  execute: async (config, ctx) => {
    if (ctx.dryRun) return { sent: false, status: 0 }
    const secret = ctx.connections.get(config.connection)
    if (secret === undefined) throw new Error(`unknown connection: ${config.connection}`)
    const parsed = parseSlackSecret(secret)
    if (parsed.kind === 'malformed') throw new Error('the Slack connection is not a webhook URL or a bot token')
    if (parsed.kind === 'webhook') {
      if (config.channel !== undefined) {
        throw new Error('this Slack connection is a webhook URL and posts to its own channel; remove the channel of this step or use a bot token connection')
      }
      const result = await httpCall(parsed.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: config.text }),
        timeoutMs: 15_000,
      })
      return { sent: true, status: result.status }
    }
    const channel = config.channel ?? parsed.channel
    if (channel === undefined) throw new Error('no Slack channel: set the channel of this step or give the connection a default channel')
    const hidden = slackSecretParts(secret)
    const result = await httpCall(POST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${parsed.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text: config.text }),
      timeoutMs: 15_000,
      redact: (text) => maskSecretParts(text, hidden),
    })
    const answer = slackAnswer(result.body)
    if (answer === undefined) throw new Error('Slack: unexpected_response')
    if (!answer.ok) {
      const code = typeof answer.error === 'string' && ERROR_CODE.test(answer.error) ? answer.error : 'unknown_error'
      const message = `Slack: ${code}`
      throw RETRYABLE_CODES.has(code) ? new RetryableError(message) : new Error(message)
    }
    return { sent: true, status: result.status }
  },
})
