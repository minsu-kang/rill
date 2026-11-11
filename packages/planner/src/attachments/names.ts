import { extractRefs, type Workflow } from '@rill/dsl'
import { declaredBranches, type NodeRegistry } from '@rill/nodes-core'
import type { PatchOp } from '../types'
import { fold } from './normalize'

export const MIN_NAME = 3

const WORDS = /[\p{L}\p{N}_]+/gu
const PLAIN = /^[\p{L}\p{N}_]+$/u

function wordsOf(text: string): string[] {
  return fold(text).match(WORDS) ?? []
}

function addWords(into: Set<string>, text: string): void {
  for (const word of wordsOf(text)) into.add(word)
}

export function collectKeys(schema: unknown, into: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectKeys(item, into)
    return
  }
  if (schema === null || typeof schema !== 'object') return
  const node = schema as Record<string, unknown>
  const properties = node.properties
  if (properties !== null && typeof properties === 'object') for (const key of Object.keys(properties)) into.add(key)
  for (const value of Object.values(node)) collectKeys(value, into)
}

function collectChoices(schema: unknown, into: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectChoices(item, into)
    return
  }
  if (schema === null || typeof schema !== 'object') return
  const node = schema as Record<string, unknown>
  if (typeof node.const === 'string') addWords(into, node.const)
  if (Array.isArray(node.enum)) for (const value of node.enum) if (typeof value === 'string') addWords(into, value)
  for (const value of Object.values(node)) collectChoices(value, into)
}

export function outputFieldNames(workflow: Workflow, registry: NodeRegistry): Set<string> {
  const names = new Set<string>()
  for (const node of workflow.nodes) {
    const def = registry.get(node.type)
    if (def === undefined) continue
    let schema: unknown = def.outputSchema
    if (def.kind === 'action' && def.outputSchemaFor !== undefined) {
      try {
        schema = def.outputSchemaFor(node.config)
      } catch {
        schema = def.outputSchema
      }
    }
    collectKeys(schema, names)
  }
  return names
}

function catalogWords(registry: NodeRegistry, workflow: Workflow | undefined): Set<string> {
  const words = new Set<string>()
  const keys = new Set<string>()
  for (const def of registry.list()) {
    addWords(words, def.type)
    collectKeys(def.configSchema, keys)
    collectKeys(def.outputSchema, keys)
    collectChoices(def.configSchema, words)
    const labels = declaredBranches(def)
    if (Array.isArray(labels)) for (const label of labels) addWords(words, label)
  }
  if (workflow !== undefined) for (const name of outputFieldNames(workflow, registry)) keys.add(name)
  for (const key of keys) addWords(words, key)
  return words
}

export interface NameGuardInput {
  attachmentTexts: readonly string[]
  userTexts?: readonly string[]
  existingWorkflow?: Workflow
  workflow?: Workflow
  registry: NodeRegistry
}

export interface NameGuard {
  /** True for a plain word of an attachment that is not a word of the user, the existing workflow or the catalog. */
  hides(name: string): boolean
}

const NOTHING_HIDDEN: NameGuard = { hides: () => false }

export function createNameGuard(input: NameGuardInput): NameGuard {
  const attachmentWords = new Set<string>()
  for (const text of input.attachmentTexts) addWords(attachmentWords, text)
  if (attachmentWords.size === 0) return NOTHING_HIDDEN
  const known = catalogWords(input.registry, input.workflow)
  for (const text of input.userTexts ?? []) addWords(known, text)
  if (input.existingWorkflow !== undefined) addWords(known, JSON.stringify(input.existingWorkflow))
  return {
    hides: (name) => {
      const word = fold(name)
      return word.length >= MIN_NAME && PLAIN.test(word) && attachmentWords.has(word) && !known.has(word)
    },
  }
}

function addKeysAndRefs(into: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    for (const ref of extractRefs(value)) {
      into.add(ref.nodeId)
      for (const segment of ref.path) into.add(segment)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) addKeysAndRefs(into, item)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    into.add(key)
    addKeysAndRefs(into, child)
  }
}

function addEdge(into: Set<string>, edge: { from: string; to: string; when?: string | undefined }): void {
  into.add(edge.from)
  into.add(edge.to)
  if (edge.when !== undefined) into.add(edge.when)
}

/** The identifiers the model picked itself: node ids, edge ends and labels, config keys and reference names. */
export function chosenNames(workflow: Workflow | undefined, patch: readonly PatchOp[] | undefined): Set<string> {
  const names = new Set<string>()
  for (const node of workflow?.nodes ?? []) {
    names.add(node.id)
    addKeysAndRefs(names, node.config)
  }
  for (const edge of workflow?.edges ?? []) addEdge(names, edge)
  for (const op of patch ?? []) {
    switch (op.op) {
      case 'add_node':
        names.add(op.node.id)
        addKeysAndRefs(names, op.node.config)
        break
      case 'set_config':
        names.add(op.nodeId)
        addKeysAndRefs(names, op.config)
        break
      case 'remove_node':
        names.add(op.nodeId)
        break
      case 'connect':
        addEdge(names, op.edge)
        break
      case 'disconnect':
        names.add(op.from)
        names.add(op.to)
        break
    }
  }
  return names
}

export function wordsIn(text: string): string[] {
  return wordsOf(text)
}
