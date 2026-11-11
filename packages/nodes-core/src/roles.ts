import type { FieldRole, NodeDefinition } from './types'

export interface RoleField {
  pointer: string
  role: FieldRole
}

export function fieldRoles(def: NodeDefinition): RoleField[] {
  return Object.entries(def.roles ?? {}).map(([pointer, role]) => ({ pointer, role }))
}

export function isWriteField(def: NodeDefinition, pointer: string): boolean {
  return def.kind === 'action' && def.sideEffect !== 'none' && def.roles?.[pointer] === 'path'
}

export function isEgressField(def: NodeDefinition, pointer: string): boolean {
  const role = def.roles?.[pointer]
  if (role === undefined) return false
  if (isWriteField(def, pointer)) return true
  return def.kind === 'action' && def.sideEffect === 'external' && (role === 'url' || role === 'connection' || role === 'recipient')
}

export function valueAtPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
