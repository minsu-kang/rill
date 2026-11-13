import { RECIPE_MAX_STRING_CHARS, RECIPE_MAX_VALUES, type RecipeParamInfo, type RecipeValues } from '@rill/protocol'
import type { MessageKey } from '../../i18n'
import type { OAuthAccount } from '../../shared/host-api'

export type FormValues = Record<string, string>

export interface HostConnection {
  name: string
  kind: 'slack' | 'http' | 'webhookSecret' | 'google' | 'microsoft'
  account?: string
  reconnect?: true
}

export type ValueError = 'required' | 'too_long' | 'not_a_number' | 'below_min' | 'above_max' | 'template_text' | 'too_many'

export type RequestValues = { ok: true; values: RecipeValues } | { ok: false; errors: Record<string, ValueError> }

const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

export function initialValues(params: readonly RecipeParamInfo[]): FormValues {
  return Object.fromEntries(params.map((param) => [param.id, param.default === undefined ? '' : String(param.default)]))
}

function tooLong(text: string): boolean {
  return text.length > RECIPE_MAX_STRING_CHARS && [...text].length > RECIPE_MAX_STRING_CHARS
}

function checkText(raw: string): { value: string } | { error: ValueError } {
  if (tooLong(raw)) return { error: 'too_long' }
  if (raw.includes('{{') || raw.includes('}}')) return { error: 'template_text' }
  return { value: raw }
}

function checkNumber(param: RecipeParamInfo, raw: string): { value: number } | { error: ValueError } {
  const text = raw.trim()
  if (!NUMBER_TEXT.test(text)) return { error: 'not_a_number' }
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return { error: 'not_a_number' }
  if (param.min !== undefined && parsed < param.min) return { error: 'below_min' }
  if (param.max !== undefined && parsed > param.max) return { error: 'above_max' }
  return { value: parsed === 0 ? 0 : parsed }
}

export function toRequestValues(params: readonly RecipeParamInfo[], values: FormValues): RequestValues {
  const entries: Array<[string, string | number]> = []
  const errors: Array<[string, ValueError]> = []
  for (const param of params) {
    const raw = valueOf(values, param.id)
    if (raw.trim() === '') {
      if (param.default === undefined) errors.push([param.id, 'required'])
      continue
    }
    const checked = param.kind === 'number' ? checkNumber(param, raw) : checkText(raw)
    if ('error' in checked) errors.push([param.id, checked.error])
    else if (entries.length >= RECIPE_MAX_VALUES) errors.push([param.id, 'too_many'])
    else entries.push([param.id, checked.value])
  }
  return errors.length > 0 ? { ok: false, errors: Object.fromEntries(errors) } : { ok: true, values: Object.fromEntries(entries) }
}

export function visibleConnections(param: RecipeParamInfo, connections: readonly HostConnection[]): HostConnection[] {
  if (param.kind !== 'connection') return []
  return connections.filter((connection) => param.connectionKind === undefined || connection.kind === param.connectionKind)
}

export function selectableConnections(param: RecipeParamInfo, connections: readonly HostConnection[]): HostConnection[] {
  return visibleConnections(param, connections).filter((connection) => connection.reconnect !== true)
}

export function accountConnections(accounts: readonly OAuthAccount[]): HostConnection[] {
  return accounts.flatMap((entry): HostConnection[] => {
    if (entry.status !== 'connected' && entry.status !== 'needs_reconnect') return []
    return [{ name: entry.provider, kind: entry.provider, ...(entry.account === undefined ? {} : { account: entry.account }), ...(entry.status === 'needs_reconnect' ? { reconnect: true as const } : {}) }]
  })
}

export function connectionsWithAccounts(saved: readonly HostConnection[], accounts: readonly OAuthAccount[]): HostConnection[] {
  return [...saved, ...accountConnections(accounts)]
}

export function withVisibleConnections(params: readonly RecipeParamInfo[], values: FormValues, connections: readonly HostConnection[]): FormValues {
  const gone = params
    .filter((param) => param.kind === 'connection' && !selectableConnections(param, connections).some((connection) => connection.name === valueOf(values, param.id)))
    .map((param) => [param.id, ''] as const)
  return gone.length === 0 ? values : { ...values, ...Object.fromEntries(gone) }
}

const ERROR_KEYS: Readonly<Record<ValueError, MessageKey>> = {
  required: 'recipes.rule.required',
  too_long: 'recipes.rule.too_long',
  not_a_number: 'recipes.error.not_a_number',
  below_min: 'recipes.rule.below_min',
  above_max: 'recipes.rule.above_max',
  template_text: 'recipes.rule.template_text',
  too_many: 'recipes.error.too_many',
}

export function valueErrorKey(error: ValueError): MessageKey {
  return ERROR_KEYS[error]
}

export function valueOf(values: FormValues, id: string): string {
  return Object.hasOwn(values, id) ? values[id]! : ''
}
