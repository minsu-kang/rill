import { createHash } from 'node:crypto'
import { NodeRegistry, createCoreRegistry, defineTrigger } from '@rill/nodes-core'
import Type from 'typebox'
import { describe, expect, it } from 'vitest'
import { HIDDEN_FIELDS, buildCatalog, catalogText } from '../src/index'

describe('buildCatalog', () => {
  it('is sorted by type and independent of registration order', () => {
    const core = createCoreRegistry()
    const reversed = new NodeRegistry()
    for (const def of [...core.list()].reverse()) reversed.register(def)
    expect(catalogText(reversed)).toBe(catalogText(core))
    const types = buildCatalog(core).map((entry) => entry.type)
    expect(types).toEqual([...types].sort())
    expect(types).toHaveLength(core.list().length)
  })

  it('has byte-stable output', () => {
    const text = catalogText(createCoreRegistry())
    expect(text).toMatchSnapshot()
    expect(createHash('sha256').update(text).digest('hex')).toBe(createHash('sha256').update(catalogText(createCoreRegistry())).digest('hex'))
  })

  it('carries type, title, description, kind, side effect, config and output schemas', () => {
    const http = buildCatalog(createCoreRegistry()).find((entry) => entry.type === 'http.request@1')!
    expect(http.kind).toBe('action')
    expect(http.sideEffect).toBe('external')
    expect(http.title).toBe('HTTP request')
    expect(http.description).toContain('Calls an HTTP endpoint')
    expect(http.roles).toEqual({ '/auth/connection': 'connection', '/url': 'url' })
    expect(Object.keys(http.config.properties as object)).toEqual(['url', 'method', 'headers', 'body', 'auth'])
    expect(http.output.type).toBe('object')
    const cron = buildCatalog(createCoreRegistry()).find((entry) => entry.type === 'trigger.cron@1')!
    expect(cron.kind).toBe('trigger')
    expect(cron.sideEffect).toBe('none')
  })

  it('never shows a hidden advanced field to the model', () => {
    const text = catalogText(createCoreRegistry())
    for (const field of HIDDEN_FIELDS) expect(text).not.toContain(`"${field}"`)
    const folder = buildCatalog(createCoreRegistry()).find((entry) => entry.type === 'trigger.folderWatch@1')!
    expect(Object.keys(folder.config.properties as object)).toEqual(['folder', 'glob', 'includeExisting'])
    expect(folder.config.required).toEqual(['folder'])
  })

  it('does not change the registry definitions when hiding fields', () => {
    const core = createCoreRegistry()
    buildCatalog(core)
    expect(Object.keys((core.get('file.read@1')!.configSchema as unknown as { properties: object }).properties)).toContain('maxBytes')
  })

  it('removes a hidden field from the required list too', () => {
    const custom = new NodeRegistry().register(
      defineTrigger({
        type: 'trigger.custom@1',
        title: 'Custom',
        description: 'Test only.',
        configSchema: Type.Object({ name: Type.String(), pollMs: Type.Integer() }),
        outputSchema: Type.Object({}),
      }),
    )
    expect(buildCatalog(custom)[0]!.config).toMatchObject({ required: ['name'], properties: { name: { type: 'string' } } })
  })

  it('explains that llm.extract output fields are the names in config.fields', () => {
    const extract = buildCatalog(createCoreRegistry()).find((entry) => entry.type === 'llm.extract@1')!
    expect(extract.outputNote).toMatch(/config\.fields/)
    expect(buildCatalog(createCoreRegistry()).find((entry) => entry.type === 'delay@1')!.outputNote).toBeUndefined()
  })

  it('is not seeded from the stale spec example', () => {
    const text = catalogText(createCoreRegistry())
    expect(text).not.toContain('"input"')
    expect(text).not.toContain('영수증')
  })
})
