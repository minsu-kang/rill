import Type from 'typebox'
import { defineTrigger } from '../types'

export const triggerManual = defineTrigger({
  type: 'trigger.manual@1',
  title: 'Manual trigger',
  description: 'Starts the workflow when a run is requested by hand. Its output is the payload.',
  configSchema: Type.Object({}, { additionalProperties: false }),
  outputSchema: Type.Record(Type.String(), Type.Unknown()),
})
