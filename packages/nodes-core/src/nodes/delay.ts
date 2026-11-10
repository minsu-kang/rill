import Type from 'typebox'
import { defineAction } from '../types'

export const delay = defineAction({
  type: 'delay@1',
  title: 'Delay',
  description: 'Waits before continuing. A run resumed after a crash waits again from the start of this node.',
  sideEffect: 'none',
  configSchema: Type.Object({ ms: Type.Integer({ minimum: 0, maximum: 86_400_000 }) }, { additionalProperties: false }),
  outputSchema: Type.Object({ waitedMs: Type.Integer() }),
  execute: async (config, ctx) => {
    if (ctx.dryRun) return { waitedMs: 0 }
    await ctx.sleep(config.ms)
    return { waitedMs: config.ms }
  },
})
