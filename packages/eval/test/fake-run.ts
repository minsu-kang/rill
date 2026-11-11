import type { LlmUsage } from '@rill/llm'
import type { Exchange } from '../src/record'
import type { FailedAttempt, FailureClass, TaskResult, TaskStatus } from '../src/runner'
import type { CallStatus, FieldOutcome } from '../src/score'

export const HAIKU = 'claude-haiku-5-5'
export const SONNET = 'claude-sonnet-5-5'
export const OPUS = 'claude-opus-5-5'

export type Outcomes = Record<string, FieldOutcome>

export const ALL_TP: Outcomes = { amount: 'TP', date: 'TP', vendor: 'TP' }
export const AMOUNT_WRONG: Outcomes = { amount: 'WRONG', date: 'TP', vendor: 'TP' }

export interface FakeTaskInput {
  caseId?: string
  group?: string
  category?: string
  kind?: string
  model?: string
  rep?: number
  status?: TaskStatus
  outcomes?: Outcomes
  extra?: Record<string, number>
  failureClass?: FailureClass
  failedAttempts?: FailedAttempt[]
  usage?: Partial<LlmUsage>
  costUsd?: number | undefined
  latencyMs?: number | undefined
  wallMs?: number
  attempts?: number
  output?: unknown
  exchanges?: Exchange[]
}

export function fakeTask(input: FakeTaskInput = {}): TaskResult<unknown> {
  const status = input.status ?? 'ok'
  const group = input.group ?? 's1'
  const kind = input.kind ?? 'text'
  const outcomes = input.outcomes ?? ALL_TP
  const scored = status === 'ok' || status === 'refused' || status === 'schema_failed' || status === 'truncated'
  const usage: LlmUsage = { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...input.usage }
  return {
    caseId: input.caseId ?? `${group}:${kind}`,
    group,
    category: input.category ?? 'easy',
    kind,
    model: input.model ?? HAIKU,
    rep: input.rep ?? 0,
    status,
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(status === 'ok' ? { output: input.output ?? { amount: 1, date: '2026-01-01', vendor: 'V' } } : {}),
    ...(scored
      ? {
          score: {
            status: status as CallStatus,
            outcomes:
              status === 'ok'
                ? outcomes
                : Object.fromEntries(Object.keys(outcomes).map((field) => [field, status === 'truncated' ? 'EXCLUDED' : 'NO_ANSWER'])),
            extra: status === 'ok' ? (input.extra ?? {}) : {},
          },
        }
      : {}),
    attempts: input.attempts ?? (status === 'skipped' ? 0 : 1),
    failedAttempts: input.failedAttempts ?? [],
    exchanges: input.exchanges ?? [],
    usage,
    costUsd: 'costUsd' in input ? input.costUsd : 0.001,
    latencyMs: 'latencyMs' in input ? input.latencyMs : 1000,
    wallMs: input.wallMs ?? 1100,
    ...(status === 'skipped' ? { skipped: 'budget' as const } : {}),
  }
}

export function fakeExchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    startedAtMs: 0,
    durationMs: 1000,
    status: 200,
    requestId: 'req_1',
    model: HAIKU,
    stopReason: 'end_turn',
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    contentBlockTypes: ['text'],
    fallbackBlocks: 0,
    thinkingChars: 0,
    bodyBytes: 100,
    failure: null,
    ...overrides,
  }
}
