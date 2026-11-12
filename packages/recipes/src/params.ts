import { isAbsolute } from 'node:path'
import { CronParseError, nextCronTime, parseCron } from '@rill/nodes-core'
import { MAX_PARAM_STRING_CHARS, PARAM_ID_PATTERN, type ParamKind, type ParamValues, type Recipe, type RecipeParam } from './types'

export const GENERAL_RULES = ['required', 'unknown_param'] as const

const TEXT_RULES = [
  'wrong_type',
  'empty',
  'too_long',
  'control_character',
  'line_separator',
  'bidi_format',
  'format_character',
  'template_text',
] as const

export const PARAM_RULES = {
  folder: [...TEXT_RULES, 'not_absolute_path', 'parent_segment'],
  file: [...TEXT_RULES, 'not_absolute_path', 'parent_segment'],
  glob: [...TEXT_RULES, 'bad_glob'],
  text: [...TEXT_RULES],
  number: ['wrong_type', 'not_finite', 'below_min', 'above_max'],
  cron: [...TEXT_RULES, 'bad_cron'],
  url: [...TEXT_RULES, 'bad_url', 'url_credentials'],
  connection: [...TEXT_RULES],
} as const satisfies Record<ParamKind, readonly string[]>

export type ParamRule = (typeof GENERAL_RULES)[number] | (typeof PARAM_RULES)[ParamKind][number]

export interface ParamProblem {
  param: string
  rule: ParamRule
}

const CONTROL = /\p{Cc}/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u
const FORMAT = /\p{Cf}|[\u{e0100}-\u{e01ef}]/u
const FORMAT_KEEPING_JOINERS = /(?![‌‍])\p{Cf}|[\u{e0100}-\u{e01ef}]/u
const PARAM_ID = new RegExp(PARAM_ID_PATTERN)

function exceedsLength(value: string): boolean {
  if (value.length <= MAX_PARAM_STRING_CHARS) return false
  let count = 0
  for (let index = 0; index < value.length; index += (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1) {
    count += 1
    if (count > MAX_PARAM_STRING_CHARS) return true
  }
  return false
}

function characterRule(value: string, keepJoiners: boolean): ParamRule | undefined {
  if (CONTROL.test(value)) return 'control_character'
  if (SEPARATOR.test(value)) return 'line_separator'
  if (BIDI.test(value)) return 'bidi_format'
  if ((keepJoiners ? FORMAT_KEEPING_JOINERS : FORMAT).test(value)) return 'format_character'
  if (value.includes('{{') || value.includes('}}')) return 'template_text'
  return undefined
}

function pathRule(value: string): ParamRule | undefined {
  const home = value.startsWith('~/') && value.length > 2
  if (!home && !isAbsolute(value)) return 'not_absolute_path'
  return value.split(/[\\/]+/).includes('..') ? 'parent_segment' : undefined
}

function globRule(value: string): ParamRule | undefined {
  return /[\\/]/.test(value) ? 'bad_glob' : undefined
}

function cronRule(value: string): ParamRule | undefined {
  try {
    return nextCronTime(parseCron(value), Date.now(), 'local') === null ? 'bad_cron' : undefined
  } catch (error) {
    if (error instanceof CronParseError) return 'bad_cron'
    throw error
  }
}

function urlRule(value: string): ParamRule | undefined {
  if (!/^https?:\/\/[^/?#\s]/.test(value) || /\s/.test(value)) return 'bad_url'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'bad_url'
  }
  if (url.hostname === '') return 'bad_url'
  return url.username !== '' || url.password !== '' ? 'url_credentials' : undefined
}

const KIND_RULES: Readonly<Record<ParamKind, ((value: string) => ParamRule | undefined) | undefined>> = {
  folder: pathRule,
  file: pathRule,
  glob: globRule,
  text: undefined,
  number: undefined,
  cron: cronRule,
  url: urlRule,
  connection: undefined,
}

function numberRule(param: RecipeParam, value: unknown): ParamRule | undefined {
  if (typeof value !== 'number') return 'wrong_type'
  if (!Number.isFinite(value)) return 'not_finite'
  if (param.min !== undefined && value < param.min) return 'below_min'
  if (param.max !== undefined && value > param.max) return 'above_max'
  return undefined
}

export function checkValue(param: RecipeParam, value: unknown): ParamRule | undefined {
  if (param.kind === 'number') return numberRule(param, value)
  if (typeof value !== 'string') return 'wrong_type'
  if (value.trim() === '') return 'empty'
  if (exceedsLength(value)) return 'too_long'
  return characterRule(value, param.kind === 'text') ?? KIND_RULES[param.kind]?.(value)
}

function givenValue(values: ParamValues, id: string): string | number | undefined {
  return Object.hasOwn(values, id) ? values[id] : undefined
}

export function valuesWithDefaults(recipe: Recipe, values: ParamValues): Map<string, string | number> {
  const filled = new Map<string, string | number>()
  for (const param of recipe.params) {
    const value = givenValue(values, param.id) ?? param.default
    if (value !== undefined) filled.set(param.id, value)
  }
  return filled
}

export function checkParams(recipe: Recipe, values: ParamValues): ParamProblem[] {
  const problems: ParamProblem[] = []
  for (const param of recipe.params) {
    const given = givenValue(values, param.id)
    if (given === undefined) {
      if (param.default === undefined) problems.push({ param: param.id, rule: 'required' })
      continue
    }
    const rule = checkValue(param, given)
    if (rule !== undefined) problems.push({ param: param.id, rule })
  }
  const declared = new Set(recipe.params.map((param) => param.id))
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) problems.push({ param: PARAM_ID.test(key) ? key : '?', rule: 'unknown_param' })
  }
  return problems
}
