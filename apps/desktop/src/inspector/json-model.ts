export const TEMPLATE_REF = /\{\{\s*[a-z][a-z0-9_]*\.output(?:\.[A-Za-z0-9_-]+)*\s*\}\}/g

export interface JsonLimits {
  maxDepth: number
  maxItems: number
  maxString: number
  maxRows: number
}

export type JsonNode =
  | { kind: 'string'; shown: string; hidden: number; full: string }
  | { kind: 'scalar'; text: string; tone: 'number' | 'boolean' | 'null' | 'other' }
  | { kind: 'container'; array: boolean; size: number; collapsed: boolean; entries: JsonEntry[]; hidden: number }

export interface JsonEntry {
  key: string
  value: JsonNode
}

const DEPTH_CEILING = 64

export function summarize(value: unknown, limits: JsonLimits): JsonNode {
  const maxDepth = Math.min(Math.max(Math.trunc(limits.maxDepth) || 0, 0), DEPTH_CEILING)
  const budget = { left: Math.max(Math.trunc(limits.maxRows) || 0, 1) }
  return build(value, 0, maxDepth, Math.max(Math.trunc(limits.maxItems) || 0, 0), Math.max(Math.trunc(limits.maxString) || 0, 0), budget)
}

function build(value: unknown, depth: number, maxDepth: number, maxItems: number, maxString: number, budget: { left: number }): JsonNode {
  budget.left -= 1
  if (value === null) return { kind: 'scalar', text: 'null', tone: 'null' }
  switch (typeof value) {
    case 'string':
      return value.length > maxString
        ? { kind: 'string', shown: value.slice(0, maxString), hidden: value.length - maxString, full: value }
        : { kind: 'string', shown: value, hidden: 0, full: value }
    case 'number':
      return { kind: 'scalar', text: String(value), tone: 'number' }
    case 'boolean':
      return { kind: 'scalar', text: String(value), tone: 'boolean' }
    case 'bigint':
      return { kind: 'scalar', text: `${value}n`, tone: 'number' }
    case 'undefined':
      return { kind: 'scalar', text: 'undefined', tone: 'other' }
    case 'symbol':
      return { kind: 'scalar', text: String(value), tone: 'other' }
    case 'function':
      return { kind: 'scalar', text: '[function]', tone: 'other' }
    default:
      return container(value as object, depth, maxDepth, maxItems, maxString, budget)
  }
}

function container(value: object, depth: number, maxDepth: number, maxItems: number, maxString: number, budget: { left: number }): JsonNode {
  const array = Array.isArray(value)
  const keys = array ? undefined : Object.keys(value)
  const size = array ? value.length : (keys?.length ?? 0)
  if (depth >= maxDepth) return { kind: 'container', array, size, collapsed: true, entries: [], hidden: size }

  const entries: JsonEntry[] = []
  const wanted = Math.min(size, maxItems)
  for (let at = 0; at < wanted && budget.left > 0; at += 1) {
    const key = keys === undefined ? String(at) : keys[at]!
    const inner = keys === undefined ? (value as unknown[])[at] : (value as Record<string, unknown>)[key]
    entries.push({ key, value: build(inner, depth + 1, maxDepth, maxItems, maxString, budget) })
  }
  return { kind: 'container', array, size, collapsed: false, entries, hidden: size - entries.length }
}
