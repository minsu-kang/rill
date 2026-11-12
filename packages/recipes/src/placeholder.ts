export const PLACEHOLDER_KEY = '$param'

export interface Placeholder {
  $param: string
}

export function param(id: string): Placeholder {
  return { $param: id }
}

export function isPlaceholderObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, PLACEHOLDER_KEY)
}
