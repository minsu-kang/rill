import { extractRefs, type PlanIssue, type Workflow } from '@rill/dsl'
import { fieldRoles, valueAtPointer, type NodeRegistry } from '@rill/nodes-core'
import { createResolver, type Resolution } from './attachments/provenance'
import type { PlanConnection } from './types'

export type ConnectionKind = PlanConnection['kind']

export const CONNECTION_KIND_CODE = 'connection_kind_mismatch'

export const CONNECTION_KINDS: Readonly<Record<string, Readonly<Record<string, ConnectionKind>>>> = {
  'notify.slack': { '/connection': 'slack' },
  'http.request': { '/auth/connection': 'http' },
  'trigger.webhook': { '/secretConnection': 'webhookSecret' },
}

function baseType(type: string): string {
  return type.replace(/@\d+$/, '')
}

export function neededConnectionKind(type: string, pointer: string): ConnectionKind | undefined {
  const table = CONNECTION_KINDS[baseType(type)]
  return table !== undefined && Object.hasOwn(table, pointer) ? table[pointer] : undefined
}

export interface ConnectionSite {
  nodeId: string
  type: string
  kind: ConnectionKind | undefined
}

export function connectionSiteAt(pointer: string, workflow: Workflow | undefined): ConnectionSite | undefined {
  const match = /^\/nodes\/(\d+)\/config(\/.*)$/.exec(pointer)
  const node = match === null ? undefined : workflow?.nodes[Number(match[1])]
  if (match === null || node === undefined) return undefined
  return { nodeId: node.id, type: node.type, kind: neededConnectionKind(node.type, match[2] as string) }
}

export function connectionKindIssues(workflow: Workflow, registry: NodeRegistry, connections: readonly PlanConnection[]): PlanIssue[] {
  const issues: PlanIssue[] = []
  const resolver = createResolver(workflow)
  workflow.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    if (def === undefined) return
    for (const { pointer, role } of fieldRoles(def)) {
      if (role !== 'connection') continue
      const value = valueAtPointer(node.config, pointer)
      const needed = neededConnectionKind(node.type, pointer)
      if (typeof value !== 'string' || needed === undefined) continue
      const names = extractRefs(value).length === 0 ? [value] : candidateNames(resolver.resolve(value))
      const configured = names.map((name) => connections.find((connection) => connection.name === name)).find((connection) => connection !== undefined && connection.kind !== needed)
      if (configured === undefined) continue
      const right = connections.filter((connection) => connection.kind === needed).map((connection) => connection.name)
      issues.push({
        stage: 3,
        pointer: `/nodes/${index}/config${pointer}`,
        code: CONNECTION_KIND_CODE,
        message: `node ${node.id}: connection ${configured.name} is a ${configured.kind} connection, but this field needs a ${needed} connection`,
        hint: right.length > 0 ? `configured ${needed} connections: ${right.join(', ')}` : `no ${needed} connections are configured`,
      })
    }
  })
  return issues
}

function candidateNames(resolution: Resolution): string[] {
  if (resolution.exact !== undefined) return [resolution.exact]
  return resolution.literals.filter((literal) => extractRefs(literal).length === 0)
}
