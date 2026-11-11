import { stringLeaves } from '@rill/dsl'
import { fieldRoles, isWriteField, type NodeDefinition } from '@rill/nodes-core'
import { CHECKED_ROLES, type CheckedRole, type UserSourcedTest } from './attachments/provenance'
import { containsAttachmentLiteral } from './attachments/redact'
import type { Flag } from './types'

export const MASK = '<hidden>'

export interface MaskInput {
  def: NodeDefinition
  nodePointer: string
  flags: readonly Flag[]
  userSourced: UserSourcedTest
  attachmentTexts: readonly string[]
}

export interface MaskedConfig {
  shown: Record<string, unknown>
  masked: Map<string, string>
}

function isWithin(pointer: string, base: string): boolean {
  return pointer === base || pointer.startsWith(`${base}/`)
}

function segments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((raw) => raw.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function setAt(target: unknown, pointer: string, value: string): void {
  const path = segments(pointer)
  const last = path.pop()
  let current = target
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return
    current = (current as Record<string, unknown>)[segment]
  }
  if (last === undefined || current === null || typeof current !== 'object' || !Object.hasOwn(current, last)) return
  ;(current as Record<string, unknown>)[last] = value
}

function getAt(target: unknown, pointer: string): unknown {
  let current = target
  for (const segment of segments(pointer)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function maskConfig(config: Record<string, unknown>, input: MaskInput): MaskedConfig {
  const roles = new Map(fieldRoles(input.def).map((field) => [field.pointer, field.role]))
  const shown = structuredClone(config)
  const masked = new Map<string, string>()
  for (const leaf of stringLeaves(config)) {
    const role = roles.get(leaf.pointer)
    const flagged = input.flags.some((flag) => isWithin(`${input.nodePointer}${leaf.pointer}`, flag.pointer))
    const notOwn =
      role !== undefined && CHECKED_ROLES.has(role) && !input.userSourced(role as CheckedRole, leaf.value, isWriteField(input.def, leaf.pointer))
    if (flagged || notOwn || containsAttachmentLiteral(leaf.value, input.attachmentTexts)) {
      masked.set(leaf.pointer, leaf.value)
      setAt(shown, leaf.pointer, MASK)
    }
  }
  return { shown, masked }
}

export function unmaskConfig(config: unknown, masked: ReadonlyMap<string, string>): unknown {
  const out = structuredClone(config)
  for (const [pointer, original] of masked) {
    if (getAt(out, pointer) === MASK) setAt(out, pointer, original)
  }
  return out
}
