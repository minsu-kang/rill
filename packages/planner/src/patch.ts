import { joinPointer, type PlanIssue, type Workflow, type WorkflowNode } from '@rill/dsl'
import type { NodeRegistry } from '@rill/nodes-core'
import { parseConfigText, type EnvelopePatchOp } from './generation'
import { hiddenValues } from './hidden'
import type { PatchOp } from './types'

export interface PatchResult {
  workflow: Workflow
  issues: PlanIssue[]
}

function issue(index: number, field: string, code: string, message: string, hint?: string): PlanIssue {
  return { stage: 2, pointer: joinPointer('/patch', index, field), code, message, ...(hint === undefined ? {} : { hint }) }
}

export function decodePatchOps(source: readonly EnvelopePatchOp[]): { ops: PatchOp[]; issues: PlanIssue[] } {
  const ops: PatchOp[] = []
  const issues: PlanIssue[] = []
  source.forEach((raw, index) => {
    const missing = (fields: (keyof EnvelopePatchOp)[]) => {
      const absent = fields.filter((field) => raw[field] === undefined)
      for (const field of absent) issues.push({ stage: 1, pointer: joinPointer('/patch', index, field), code: 'patch_missing_field', message: `${raw.op} needs ${field}` })
      return absent.length > 0
    }
    const config = (): Record<string, unknown> | undefined => {
      const parsed = parseConfigText(raw.config as string, joinPointer('/patch', index, 'config'))
      if (parsed.issue) issues.push(parsed.issue)
      return parsed.config
    }
    switch (raw.op) {
      case 'add_node': {
        if (missing(['nodeId', 'type', 'config'])) return
        const parsed = config()
        if (parsed === undefined) return
        const node: WorkflowNode = {
          id: raw.nodeId as string,
          type: raw.type as string,
          config: parsed,
          ...(raw.retry === undefined ? {} : { retry: { ...raw.retry } }),
          ...(raw.onError === undefined ? {} : { onError: raw.onError }),
        }
        ops.push({ op: 'add_node', node })
        return
      }
      case 'set_config': {
        if (missing(['nodeId', 'config'])) return
        const parsed = config()
        if (parsed === undefined) return
        ops.push({
          op: 'set_config',
          nodeId: raw.nodeId as string,
          config: parsed,
          ...(raw.retry === undefined ? {} : { retry: { ...raw.retry } }),
          ...(raw.onError === undefined ? {} : { onError: raw.onError }),
        })
        return
      }
      case 'remove_node':
        if (!missing(['nodeId'])) ops.push({ op: 'remove_node', nodeId: raw.nodeId as string })
        return
      case 'connect':
        if (!missing(['from', 'to'])) {
          ops.push({ op: 'connect', edge: { from: raw.from as string, to: raw.to as string, ...(raw.when === undefined ? {} : { when: raw.when }) } })
        }
        return
      case 'disconnect':
        if (!missing(['from', 'to'])) ops.push({ op: 'disconnect', from: raw.from as string, to: raw.to as string })
        return
    }
  })
  return { ops, issues }
}

export function applyPatch(existing: Workflow, ops: readonly PatchOp[], registry: NodeRegistry): PatchResult {
  const workflow = structuredClone(existing)
  const issues: PlanIssue[] = []
  const has = (id: string) => workflow.nodes.some((node) => node.id === id)
  const unknown = (index: number, field: string, id: string) =>
    issues.push(issue(index, field, 'patch_unknown_node', `no node with id ${id} in the workflow`, `existing ids: ${workflow.nodes.map((n) => n.id).join(', ')}`))
  ops.forEach((op, index) => {
    switch (op.op) {
      case 'add_node':
        if (has(op.node.id)) {
          issues.push(issue(index, 'nodeId', 'patch_duplicate_node', `a node with id ${op.node.id} already exists`, 'use set_config to change it or pick a new id'))
          return
        }
        workflow.nodes.push(structuredClone(op.node))
        return
      case 'set_config': {
        const node = workflow.nodes.find((n) => n.id === op.nodeId)
        if (node === undefined) return unknown(index, 'nodeId', op.nodeId)
        node.config = { ...structuredClone(op.config), ...hiddenValues(registry.get(node.type), node.config) }
        if (op.retry !== undefined) node.retry = { ...op.retry }
        if (op.onError !== undefined) node.onError = op.onError
        return
      }
      case 'remove_node':
        if (!has(op.nodeId)) return unknown(index, 'nodeId', op.nodeId)
        workflow.nodes = workflow.nodes.filter((n) => n.id !== op.nodeId)
        workflow.edges = workflow.edges.filter((e) => e.from !== op.nodeId && e.to !== op.nodeId)
        return
      case 'connect': {
        const { from, to } = op.edge
        if (!has(from)) return unknown(index, 'from', from)
        if (!has(to)) return unknown(index, 'to', to)
        if (workflow.edges.some((e) => e.from === from && e.to === to)) {
          issues.push(issue(index, 'to', 'patch_duplicate_edge', `edge ${from} -> ${to} already exists`, 'disconnect it first to change its label'))
          return
        }
        workflow.edges.push({ ...op.edge })
        return
      }
      case 'disconnect': {
        const before = workflow.edges.length
        workflow.edges = workflow.edges.filter((e) => !(e.from === op.from && e.to === op.to))
        if (workflow.edges.length === before) {
          issues.push(issue(index, 'to', 'patch_unknown_edge', `no edge ${op.from} -> ${op.to} in the workflow`))
        }
        return
      }
    }
  })
  return { workflow, issues }
}

export function touchedOutsideSelection(ops: readonly PatchOp[], existing: Workflow, selection: string): string[] {
  const existingIds = new Set(existing.nodes.map((n) => n.id))
  const touched = new Set<string>()
  const mark = (id: string) => {
    if (id !== selection && existingIds.has(id)) touched.add(id)
  }
  for (const op of ops) {
    if (op.op === 'set_config' || op.op === 'remove_node') mark(op.nodeId)
    else if (op.op === 'connect' || op.op === 'disconnect') {
      const from = op.op === 'connect' ? op.edge.from : op.from
      const to = op.op === 'connect' ? op.edge.to : op.to
      if (from !== selection && to !== selection) {
        mark(from)
        mark(to)
      }
    }
  }
  return [...touched].sort()
}

export function labelIssuesForPatch(issues: readonly PlanIssue[], workflow: Workflow): PlanIssue[] {
  return issues.map((item) => {
    const node = /^\/nodes\/(\d+)(\/|$)/.exec(item.pointer)
    if (node) {
      const id = workflow.nodes[Number(node[1])]?.id
      if (id === undefined || new RegExp(`^(node|trigger) ${id}:`).test(item.message)) return item
      return { ...item, message: `node ${id}: ${item.message}` }
    }
    const edge = /^\/edges\/(\d+)(\/|$)/.exec(item.pointer)
    if (edge) {
      const found = workflow.edges[Number(edge[1])]
      if (found === undefined || item.message.startsWith('edge ')) return item
      return { ...item, message: `edge ${found.from} -> ${found.to}: ${item.message}` }
    }
    return item
  })
}
