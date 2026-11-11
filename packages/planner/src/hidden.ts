import { joinPointer, type PlanIssue } from '@rill/dsl'
import type { NodeDefinition, NodeRegistry } from '@rill/nodes-core'

export const HIDDEN_FIELDS = ['pollMs', 'stableMs', 'timeoutMs', 'maxBytes', 'overlap'] as const

export const HIDDEN_FIELD_CODE = 'planner_hidden_field'

type Json = Record<string, unknown>

function properties(def: NodeDefinition): Json {
  const schema = def.configSchema as unknown as Json
  return (schema.properties ?? {}) as Json
}

export function hiddenFieldsOf(def: NodeDefinition): string[] {
  const props = properties(def)
  return HIDDEN_FIELDS.filter((name) => Object.hasOwn(props, name))
}

export function withoutHiddenFields(def: NodeDefinition): Json {
  const schema = structuredClone(def.configSchema as unknown as Json)
  const hidden = hiddenFieldsOf(def)
  if (hidden.length === 0) return schema
  const props = { ...(schema.properties as Json) }
  for (const name of hidden) delete props[name]
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((name) => !hidden.includes(name)) : undefined
  return { ...schema, properties: props, ...(required === undefined ? {} : { required }) }
}

export function hiddenValues(def: NodeDefinition | undefined, config: Record<string, unknown>): Record<string, unknown> {
  if (def === undefined) return {}
  return Object.fromEntries(hiddenFieldsOf(def).filter((name) => Object.hasOwn(config, name)).map((name) => [name, config[name]]))
}

export interface ConfigSite {
  type: string
  config: unknown
  pointer: string
  nodeId?: string
}

export function hiddenFieldIssues(sites: readonly ConfigSite[], registry: NodeRegistry): PlanIssue[] {
  const issues: PlanIssue[] = []
  for (const site of sites) {
    const def = registry.get(site.type)
    if (def === undefined || site.config === null || typeof site.config !== 'object') continue
    for (const name of hiddenFieldsOf(def)) {
      if (!Object.hasOwn(site.config, name)) continue
      const label = site.nodeId === undefined ? '' : `node ${site.nodeId}: `
      issues.push({
        stage: 3,
        pointer: joinPointer(site.pointer, name),
        code: HIDDEN_FIELD_CODE,
        message: `${label}${name} is an advanced setting the user sets in the inspector; do not set it`,
        hint: `remove ${name}`,
      })
    }
  }
  return issues
}
