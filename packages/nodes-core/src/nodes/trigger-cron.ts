import Type from 'typebox'
import { nextCronTime, parseCron } from '../cron'
import { defineTrigger } from '../types'

export const cronConfigSchema = Type.Object(
  {
    expression: Type.String({ minLength: 1 }),
    timezone: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('utc')])),
    catchUp: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('once')])),
    overlap: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('queue')])),
  },
  { additionalProperties: false },
)

export type CronTriggerConfig = Type.Static<typeof cronConfigSchema>

export const triggerCron = defineTrigger({
  type: 'trigger.cron@1',
  title: 'Schedule',
  description:
    'Starts the workflow on a five-field cron schedule. A schedule missed for more than a minute is skipped, or run once with catchUp "once"; with overlap "skip" a tick is dropped while the previous run is still active.',
  configSchema: cronConfigSchema,
  outputSchema: Type.Object({ scheduledFor: Type.String(), firedAt: Type.String() }),
  validate: (config) => {
    const { expression, timezone } = config as CronTriggerConfig
    try {
      const spec = parseCron(expression)
      return nextCronTime(spec, Date.now(), timezone ?? 'local') === null ? ['expression never fires'] : []
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)]
    }
  },
})
