import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createCoreRegistry, declaredBranches } from '../src/index'
import { triggerCron } from '../src/nodes/trigger-cron'
import { triggerFolderWatch } from '../src/nodes/trigger-folder-watch'
import { triggerManual } from '../src/nodes/trigger-manual'
import { triggerWebhook } from '../src/nodes/trigger-webhook'

describe('trigger definitions', () => {
  it('are registered and are triggers that produce no branch', () => {
    const registry = createCoreRegistry()
    for (const def of [triggerManual, triggerCron, triggerFolderWatch, triggerWebhook]) {
      expect(registry.get(def.type)?.kind).toBe('trigger')
      expect(declaredBranches(def)).toBeNull()
    }
  })
})

describe('trigger.manual@1', () => {
  it('accepts only an empty config', () => {
    expect(Value.Check(triggerManual.configSchema, {})).toBe(true)
    expect(Value.Check(triggerManual.configSchema, { x: 1 })).toBe(false)
  })
})

describe('trigger.cron@1', () => {
  it('checks its config schema', () => {
    const ok = { expression: '0 9 * * *', timezone: 'utc', catchUp: 'once', overlap: 'queue' }
    expect(Value.Check(triggerCron.configSchema, ok)).toBe(true)
    expect(Value.Check(triggerCron.configSchema, { expression: '' })).toBe(false)
    expect(Value.Check(triggerCron.configSchema, { expression: '* * * * *', timezone: 'mars' })).toBe(false)
    expect(Value.Check(triggerCron.configSchema, { expression: '* * * * *', extra: 1 })).toBe(false)
  })

  it('validates the expression at deploy time', () => {
    expect(triggerCron.validate?.({ expression: '*/5 * * * *' })).toEqual([])
    expect(triggerCron.validate?.({ expression: '61 * * * *' })).toEqual(['minute out of range 0-59: 61'])
    expect(triggerCron.validate?.({ expression: '0 0 31 2 *' })).toEqual(['expression never fires'])
  })
})

describe('trigger.folderWatch@1', () => {
  it('checks its config schema', () => {
    expect(Value.Check(triggerFolderWatch.configSchema, { folder: '~/Receipts' })).toBe(true)
    expect(
      Value.Check(triggerFolderWatch.configSchema, {
        folder: '/x',
        glob: '*.pdf',
        pollMs: 200,
        stableMs: 0,
        includeExisting: true,
      }),
    ).toBe(true)
    expect(Value.Check(triggerFolderWatch.configSchema, { folder: '/x', pollMs: 100 })).toBe(false)
    expect(Value.Check(triggerFolderWatch.configSchema, { folder: '/x', stableMs: 70_000 })).toBe(false)
    expect(Value.Check(triggerFolderWatch.configSchema, {})).toBe(false)
  })

  it('only allows globs that match file names', () => {
    expect(triggerFolderWatch.validate?.({ folder: '/x', glob: '*.pdf' })).toEqual([])
    expect(triggerFolderWatch.validate?.({ folder: '/x', glob: 'sub/*.pdf' })).toEqual([
      'glob must match file names only, without path separators',
    ])
    expect(triggerFolderWatch.validate?.({ folder: '/x', glob: '..\\x' })).toHaveLength(1)
  })
})

describe('trigger.webhook@1', () => {
  it('checks its config schema', () => {
    expect(Value.Check(triggerWebhook.configSchema, { path: '/hooks/receipts' })).toBe(true)
    expect(
      Value.Check(triggerWebhook.configSchema, { path: '/a', method: 'PUT', secretConnection: 'hook' }),
    ).toBe(true)
    expect(Value.Check(triggerWebhook.configSchema, { path: 'no-slash' })).toBe(false)
    expect(Value.Check(triggerWebhook.configSchema, { path: '/a b' })).toBe(false)
    expect(Value.Check(triggerWebhook.configSchema, { path: '/a', method: 'DELETE' })).toBe(false)
  })

  it('rejects paths with dot segments, repeated or trailing slashes', () => {
    const message = ["path must not contain '.', '..' or empty segments"]
    expect(triggerWebhook.validate?.({ path: '/hooks/a' })).toEqual([])
    expect(triggerWebhook.validate?.({ path: '/hooks/../a' })).toEqual(message)
    expect(triggerWebhook.validate?.({ path: '/hooks/./b' })).toEqual(message)
    expect(triggerWebhook.validate?.({ path: '/hooks//a' })).toEqual(message)
    expect(triggerWebhook.validate?.({ path: '/hooks/' })).toEqual(message)
  })
})
