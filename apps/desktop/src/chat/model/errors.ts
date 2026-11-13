import type { MessageKey } from '../../i18n'

const KEYS: Readonly<Record<string, MessageKey>> = {
  LLM_UNAVAILABLE: 'chat.error.LLM_UNAVAILABLE',
  PLAN_INVALID: 'chat.error.PLAN_INVALID',
  PLAN_PROVIDER: 'chat.error.PLAN_PROVIDER',
  PLAN_CANCELLED: 'chat.error.PLAN_CANCELLED',
  PLAN_BUSY: 'chat.error.PLAN_BUSY',
  PLAN_EXISTS: 'chat.error.PLAN_EXISTS',
  PLAN_NOT_CONFIRMED: 'chat.error.PLAN_NOT_CONFIRMED',
  PLAN_DEPLOYED: 'chat.error.PLAN_DEPLOYED',
  ATTACHMENT_REJECTED: 'chat.error.ATTACHMENT_REJECTED',
  MEMORY_INVALID: 'chat.error.MEMORY_INVALID',
  MEMORY_FULL: 'chat.error.MEMORY_FULL',
  MEMORY_DUPLICATE: 'chat.error.MEMORY_DUPLICATE',
  AGENT_NOT_FOUND: 'chat.error.AGENT_NOT_FOUND',
  AGENT_INVALID: 'chat.error.AGENT_INVALID',
  AGENT_FULL: 'chat.error.AGENT_FULL',
  AGENT_DUPLICATE: 'chat.error.AGENT_DUPLICATE',
  AGENT_BUILTIN: 'chat.error.AGENT_BUILTIN',
  INVALID_PARAMS: 'chat.error.INVALID_PARAMS',
  INVALID_WORKFLOW: 'chat.error.INVALID_WORKFLOW',
  NOT_FOUND: 'chat.error.NOT_FOUND',
  INTERNAL: 'chat.error.INTERNAL',
  BAD_RESPONSE: 'chat.error.BAD_RESPONSE',
}

const RULES: Readonly<Record<string, MessageKey>> = {
  empty: 'chat.memory.rule.empty',
  control_character: 'chat.memory.rule.control_character',
  line_separator: 'chat.memory.rule.line_separator',
  bidi_format: 'chat.memory.rule.bidi_format',
  format_character: 'chat.memory.rule.format_character',
  too_long: 'chat.memory.rule.too_long',
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function planErrorKey(error: unknown): MessageKey {
  const code = codeOf(error)
  return code !== undefined && Object.hasOwn(KEYS, code) ? KEYS[code]! : 'chat.error.generic'
}

export function memoryErrorKey(error: unknown): MessageKey {
  if (codeOf(error) !== 'MEMORY_INVALID') return planErrorKey(error)
  const problems = (error as { problems?: unknown }).problems
  const first = Array.isArray(problems) && typeof problems[0] === 'string' ? problems[0] : ''
  const rule = first.split(':')[0]!.trim()
  return Object.hasOwn(RULES, rule) ? RULES[rule]! : 'chat.memory.rule.invalid'
}
