import { extractRefs, type PlanIssue, type Workflow } from '@rill/dsl'
import { fieldRoles, valueAtPointer, type NodeRegistry } from '@rill/nodes-core'
import { createResolver, type Resolution } from './attachments/provenance'
import type { PlanConnection } from './types'

export type ConnectionKind = PlanConnection['kind']

export const CONNECTION_KIND_CODE = 'connection_kind_mismatch'
export const CHANNEL_ON_WEBHOOK_CODE = 'channel_on_webhook'

export const CONNECTION_KINDS: Readonly<Record<string, Readonly<Record<string, ConnectionKind>>>> = {
  'notify.slack': { '/connection': 'slack' },
  'http.request': { '/auth/connection': 'http' },
  'trigger.webhook': { '/secretConnection': 'webhookSecret' },
  'google.sheets.append': { '/connection': 'google' },
  'microsoft.excel.append': { '/connection': 'microsoft' },
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
      const names = namesOf(value, resolver)
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

function namesOf(value: string, resolver: ReturnType<typeof createResolver>): string[] {
  return extractRefs(value).length === 0 ? [value] : candidateNames(resolver.resolve(value))
}

export function slackChannelIssues(workflow: Workflow, registry: NodeRegistry, connections: readonly PlanConnection[]): PlanIssue[] {
  const issues: PlanIssue[] = []
  const resolver = createResolver(workflow)
  workflow.nodes.forEach((node, index) => {
    if (baseType(node.type) !== 'notify.slack' || registry.get(node.type) === undefined) return
    const value = valueAtPointer(node.config, '/connection')
    if (typeof value !== 'string' || valueAtPointer(node.config, '/channel') === undefined) return
    const webhook = namesOf(value, resolver)
      .map((name) => connections.find((connection) => connection.name === name))
      .find((connection) => connection?.kind === 'slack' && connection.slack === 'webhook')
    if (webhook === undefined) return
    const bots = connections.filter((connection) => connection.kind === 'slack' && connection.slack === 'bot').map((connection) => connection.name)
    issues.push({
      stage: 3,
      pointer: `/nodes/${index}/config/channel`,
      code: CHANNEL_ON_WEBHOOK_CODE,
      message: `node ${node.id}: connection ${webhook.name} is a Slack webhook connection and posts to its own channel, so this step cannot set a channel`,
      hint: `a webhook connection posts to its own channel: remove the channel of this step${bots.length > 0 ? ` or use a bot connection: ${bots.join(', ')}` : ''}`,
    })
  })
  return issues
}

function candidateNames(resolution: Resolution): string[] {
  if (resolution.exact !== undefined) return [resolution.exact]
  return resolution.literals.filter((literal) => extractRefs(literal).length === 0)
}
