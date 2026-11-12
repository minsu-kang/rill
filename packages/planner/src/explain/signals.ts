import type { Workflow } from '@rill/dsl'
import type { NodeRegistry } from '@rill/nodes-core'
import type { ExplainSignal, ExplainStep, FailureSignal } from './types'

type Rule = readonly [RegExp, FailureSignal]

const GUARDS: readonly Rule[] = [
  [/^unknown connection: /, 'unknown_connection'],
  [/^path is outside the allowed folders: /, 'path_not_allowed'],
  [/^path must be absolute or start with ~\/: /, 'path_not_allowed'],
  [/^path must not contain '\.\.': /, 'path_not_allowed'],
  [/^path is a dangling symlink: /, 'path_not_allowed'],
  [/^invalid config: /, 'invalid_config'],
  [/^invalid request: /, 'invalid_config'],
  [/^unsupported protocol: /, 'invalid_config'],
  [/^GET requests cannot have a body$/, 'invalid_config'],
  [/^unresolved reference: /, 'unresolved_reference'],
]

const TRANSPORT: readonly Rule[] = [
  [/^HTTP (401|403)\b/, 'http_status_401_403'],
  [/^HTTP 404\b/, 'http_status_404'],
  [/^HTTP 429\b/, 'http_status_429'],
  [/^HTTP 5\d\d\b/, 'http_status_5xx'],
  [/^HTTP 4\d\d\b/, 'http_status_4xx'],
  [/^network error: (TimeoutError|AbortError|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_[A-Z_]*TIMEOUT)$/, 'timeout'],
  [/^network error: /, 'network_error'],
]

const FILE_SYSTEM_CODE = /^E[A-Z0-9]+: /
const FILE_PROBLEM = /^(file is |file content |file changed |not a file: |unsupported file type)/
const LLM_RULES: readonly Rule[] = [
  [/needs an LLM provider|^no (?:API key for |[A-Za-z]+ credentials found)|rejected the credentials|billing or credit|insufficient_quota|refused account access|refused the request \((?:401|402|403)\b/, 'llm_unavailable'],
  [/rate limiting requests|refused the request \(429\b/, 'http_status_429'],
  [/^the model provider timed out \(/, 'timeout'],
  [/^the model provider had a server error \(5\d\d\)/, 'http_status_5xx'],
  [/^llm\.extract reads files only inside allowed folders/, 'path_not_allowed'],
]

function firstMatch(rules: readonly Rule[], message: string): FailureSignal | undefined {
  return rules.find(([pattern]) => pattern.test(message))?.[1]
}

function baseType(type: string): string {
  return type.replace(/@\d+$/, '')
}

function fileSignal(message: string): FailureSignal | undefined {
  if (message.startsWith('ENOENT: ')) return 'file_missing'
  if (FILE_SYSTEM_CODE.test(message) || FILE_PROBLEM.test(message)) return 'file_unreadable'
  return undefined
}

function specific(type: string, message: string): FailureSignal | undefined {
  switch (baseType(type)) {
    case 'file.read':
      return fileSignal(message)
    case 'llm.extract':
      return fileSignal(message) ?? firstMatch(LLM_RULES, message) ?? 'llm_extract_failed'
    case 'notify.slack':
      return /^HTTP 4\d\d\b/.test(message) && !message.startsWith('HTTP 429') ? 'slack_error' : undefined
    case 'csv.append':
      return 'csv_error'
    case 'condition':
      return 'condition_error'
    default:
      return undefined
  }
}

function classify(message: string, type: string | undefined, registry: NodeRegistry): FailureSignal {
  const guard = firstMatch(GUARDS, message)
  if (guard !== undefined) return guard
  const own = type !== undefined && registry.has(type) ? specific(type, message) : undefined
  return own ?? firstMatch(TRANSPORT, message) ?? 'unknown'
}

export function failureSignals(steps: readonly ExplainStep[], registry: NodeRegistry, workflow: Workflow): ExplainSignal[] {
  const types = new Map(workflow.nodes.map((node) => [node.id, node.type]))
  const last = new Map<string, ExplainStep>()
  for (const step of steps) last.set(step.nodeId, step)
  const signals: ExplainSignal[] = []
  for (const [nodeId, step] of last) {
    if (!types.has(nodeId) || (step.status !== 'failed' && step.status !== 'continued')) continue
    signals.push({ nodeId, signal: classify(step.error ?? '', types.get(nodeId), registry) })
  }
  return signals
}
