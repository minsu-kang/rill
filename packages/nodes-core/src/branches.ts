import type { NodeDefinition } from './types'

export function declaredBranches(def: NodeDefinition): string[] | 'any' | null {
  if (def.kind === 'trigger') return null
  const properties = (def.outputSchema as unknown as { properties?: Record<string, unknown> }).properties
  const branch = properties?.branch as { anyOf?: unknown[]; enum?: unknown[]; const?: unknown } | undefined
  if (branch === undefined) return null
  const values: unknown[] = []
  for (const part of branch.anyOf ?? [branch]) {
    const literal = part as { const?: unknown; enum?: unknown[] }
    if (literal.const !== undefined) values.push(literal.const)
    else if (Array.isArray(literal.enum)) values.push(...literal.enum)
    else return 'any'
  }
  return values.length > 0 && values.every((v) => typeof v === 'string') ? (values as string[]) : 'any'
}
