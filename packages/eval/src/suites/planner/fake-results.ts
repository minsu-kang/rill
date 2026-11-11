import type { PlanIssue, Workflow } from '@rill/dsl'
import type { LlmUsage } from '@rill/llm'
import type { Flag, PlanQuestion, PlanResult, PlanResultBody, PlanRound } from '@rill/planner'

export function fakeUsage(): LlmUsage {
  return { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

export function fakeRound(index: number, issues: PlanIssue[] = [], targeted: string[] = [], durationMs = 100): PlanRound {
  return { index, issues, usage: fakeUsage(), durationMs, targeted }
}

export const ERROR_ISSUE: PlanIssue = { stage: 3, pointer: '/nodes/1/config', code: 'config_type', message: 'must be string' }
export const WARNING_ISSUE: PlanIssue = { stage: 3, pointer: '/nodes/1/config/x', code: 'nullable_into_required', message: 'nullable' }

export function fakeResult(body: PlanResultBody, rounds: PlanRound[] = [fakeRound(0)]): PlanResult {
  return { ...body, rounds, usage: fakeUsage(), costUsd: 0, model: 'fake-planner', effort: 'low', fallbackUsed: false }
}

export function workflowBody(workflow: Workflow, flags: Flag[] = [], needsConfirmation = flags.length > 0): PlanResultBody {
  return { kind: 'workflow', workflow, summary: 'planned', flags, needsConfirmation }
}

export function questionsBody(texts: readonly string[]): PlanResultBody {
  const questions: PlanQuestion[] = texts.map((text, index) => ({ id: `q${index + 1}`, text, options: ['a', 'b'], default: 'a' }))
  return { kind: 'questions', questions, summary: 'need more information' }
}

export function unsupportedBody(reason: string): PlanResultBody {
  return { kind: 'unsupported', reason, nearest: 'a CSV file can be written instead', summary: reason }
}
