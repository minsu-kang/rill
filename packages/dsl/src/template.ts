export interface TemplateRef {
  nodeId: string
  path: string[]
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

const REF_SOURCE = String.raw`\{\{\s*([a-z][a-z0-9_]*)\.output((?:\.[A-Za-z0-9_-]+)*)\s*\}\}`
const REF_ANY = new RegExp(REF_SOURCE, 'g')
const REF_WHOLE = new RegExp(`^\\s*${REF_SOURCE}\\s*$`)
const MALFORMED_SPAN = /\{\{[\s\S]*?\}\}/g

function parsePath(raw: string): string[] {
  return raw === '' ? [] : raw.slice(1).split('.')
}

function show(ref: TemplateRef): string {
  return [ref.nodeId, 'output', ...ref.path].join('.')
}

function lookup(ref: TemplateRef, outputs: Record<string, unknown>): unknown {
  if (!Object.hasOwn(outputs, ref.nodeId)) throw new TemplateError(`unresolved reference: ${show(ref)}`)
  let current: unknown = outputs[ref.nodeId]
  for (const segment of ref.path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      throw new TemplateError(`unresolved reference: ${show(ref)}`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null')
}

export function extractRefs(value: unknown): TemplateRef[] {
  if (typeof value === 'string') {
    return [...value.matchAll(REF_ANY)].map((m) => ({ nodeId: m[1]!, path: parsePath(m[2]!) }))
  }
  if (Array.isArray(value)) return value.flatMap((v) => extractRefs(v))
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap((v) => extractRefs(v))
  return []
}

export function findMalformedTemplates(value: unknown): string[] {
  if (typeof value === 'string') return (value.match(MALFORMED_SPAN) ?? []).filter((span) => !REF_WHOLE.test(span))
  if (Array.isArray(value)) return value.flatMap((v) => findMalformedTemplates(v))
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap((v) => findMalformedTemplates(v))
  return []
}

export function resolveTemplates(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = REF_WHOLE.exec(value)
    if (whole) return lookup({ nodeId: whole[1]!, path: parsePath(whole[2]!) }, outputs)
    return value.replace(REF_ANY, (_match, nodeId: string, path: string) =>
      stringify(lookup({ nodeId, path: parsePath(path) }, outputs)),
    )
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, outputs))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, outputs)]))
  }
  return value
}
