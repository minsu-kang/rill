import Type from 'typebox'
import { httpCall } from '../http'
import { defineAction } from '../types'

export const notifySlack = defineAction({
  type: 'notify.slack@1',
  title: 'Slack message',
  description:
    'Posts a message through a Slack incoming webhook connection. A crash right after sending can make a resumed run send it twice.',
  sideEffect: 'external',
  roles: { '/connection': 'connection', '/text': 'message' },
  configSchema: Type.Object(
    {
      connection: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1, maxLength: 3000 }),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object({ sent: Type.Boolean(), status: Type.Integer() }),
  execute: async (config, ctx) => {
    if (ctx.dryRun) return { sent: false, status: 0 }
    const url = ctx.connections.get(config.connection)
    if (url === undefined) throw new Error(`unknown connection: ${config.connection}`)
    const result = await httpCall(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: config.text }),
      timeoutMs: 15_000,
    })
    return { sent: true, status: result.status }
  },
})
