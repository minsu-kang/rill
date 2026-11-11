import Type from 'typebox'
import { defineTrigger } from '../types'

export const webhookConfigSchema = Type.Object(
  {
    path: Type.String({ pattern: '^/[A-Za-z0-9._~/-]{1,128}$' }),
    method: Type.Optional(Type.Union([Type.Literal('POST'), Type.Literal('PUT'), Type.Literal('GET')])),
    secretConnection: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

export type WebhookTriggerConfig = Type.Static<typeof webhookConfigSchema>

export const triggerWebhook = defineTrigger({
  type: 'trigger.webhook@1',
  title: 'Webhook',
  description:
    'Starts the workflow when a request reaches a path on the local webhook server (127.0.0.1 only). With secretConnection the request must send the secret in the x-rill-secret header.',
  configSchema: webhookConfigSchema,
  roles: { '/secretConnection': 'connection' },
  outputSchema: Type.Object({
    method: Type.String(),
    path: Type.String(),
    query: Type.Record(Type.String(), Type.String()),
    headers: Type.Record(Type.String(), Type.String()),
    body: Type.Unknown(),
  }),
  validate: (config) => {
    const segments = (config as WebhookTriggerConfig).path.split('/').slice(1)
    return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
      ? ["path must not contain '.', '..' or empty segments"]
      : []
  },
})
