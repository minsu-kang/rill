import Type from 'typebox'
import { SLACK_CHANNEL_MAX } from '../slack-connection'
import { postSlackMessage } from '../slack-post'
import { defineAction } from '../types'

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
    const posted = await postSlackMessage({ secret, text: config.text, channel: config.channel, timeoutMs: 15_000 })
    if (!posted.ok) throw posted.error
    return { sent: true, status: posted.status }
  },
})
