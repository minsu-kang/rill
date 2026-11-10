import Type from 'typebox'
import { defineAction } from '../types'

export const transform = defineAction({
  type: 'transform@1',
  title: 'Transform',
  description: 'Builds a new object from literal values and references to earlier node outputs.',
  sideEffect: 'none',
  configSchema: Type.Object(
    { values: Type.Record(Type.String(), Type.Unknown()) },
    { additionalProperties: false },
  ),
  outputSchema: Type.Record(Type.String(), Type.Unknown()),
  execute: async (config) => config.values,
})
