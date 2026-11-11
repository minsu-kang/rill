import type { FieldRole, NodeDefinition, NodeRegistry, SideEffect } from '@rill/nodes-core'
import { withoutHiddenFields } from './hidden'

export interface CatalogEntry {
  type: string
  title: string
  description: string
  kind: 'trigger' | 'action'
  sideEffect: SideEffect
  roles?: Record<string, FieldRole>
  config: Record<string, unknown>
  output: Record<string, unknown>
  outputNote?: string
}

const OUTPUT_NOTES: Readonly<Record<string, string>> = {
  'llm.extract@1':
    'The output is an object whose field names are exactly the names listed in config.fields; each value has the declared type or is null when the document does not state it. Reference them as {{id.output.<name>}}.',
}

function plain(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
}

function entryOf(def: NodeDefinition): CatalogEntry {
  const note = OUTPUT_NOTES[def.type] ?? (def.kind === 'action' && def.outputSchemaFor ? 'The output fields depend on the config.' : undefined)
  const roles = def.roles === undefined || Object.keys(def.roles).length === 0 ? undefined : Object.fromEntries(Object.entries(def.roles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return {
    type: def.type,
    title: def.title,
    description: def.description,
    kind: def.kind,
    sideEffect: def.kind === 'action' ? def.sideEffect : 'none',
    ...(roles === undefined ? {} : { roles }),
    config: plain(withoutHiddenFields(def)),
    output: plain(def.outputSchema),
    ...(note === undefined ? {} : { outputNote: note }),
  }
}

export function buildCatalog(registry: NodeRegistry): CatalogEntry[] {
  return registry
    .list()
    .map(entryOf)
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
}

export function catalogText(registry: NodeRegistry): string {
  const entries = buildCatalog(registry)
  return ['Node catalog (JSON, one entry per line, sorted by type):', ...entries.map((entry) => JSON.stringify(entry))].join('\n')
}
