import type { Workflow } from '@rill/dsl'
import { LlmError, type LlmCallOptions, type LlmProvider, type LlmRequest, type LlmResult, type LlmUsage } from '@rill/llm'
import { encodeGeneration } from '@rill/planner'
import type { PatchOp, PlanQuestion } from '@rill/protocol'
import type { EnginePlanInput } from '../src/engine'
import { waitFor } from './process'

export type Step =
  | { data: unknown; usage?: Partial<LlmUsage>; model?: string }
  | { error: Error }
  | { wait: true; abortDelayMs?: number }
  | { gate: Promise<void>; data: unknown }

export const MODEL = 'claude-sonnet-5-5'

export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted'
  readonly requests: LlmRequest[] = []
  readonly signals: Array<AbortSignal | undefined> = []
  private readonly steps: Step[]

  constructor(steps: Step[]) {
    this.steps = [...steps]
  }

  async calls(count: number): Promise<void> {
    await waitFor(() => this.requests.length >= count)
  }

  generate(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> {
    this.requests.push(structuredClone(request))
    this.signals.push(options?.signal)
    const step = this.steps.shift()
    if (step === undefined) return Promise.reject(new Error(`scripted provider: no step for call ${this.requests.length}`))
    if ('error' in step) return Promise.reject(step.error)
    const reply = (data: unknown, usage: Partial<LlmUsage> = {}, model = MODEL): LlmResult => ({
      data: structuredClone(data),
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...usage },
      model,
      requestedModel: MODEL,
      stopReason: 'end_turn',
      durationMs: 3,
      fallbackUsed: false,
      servedModels: [model],
    })
    if ('data' in step && !('gate' in step)) return Promise.resolve(reply(step.data, step.usage, step.model))
    return new Promise<LlmResult>((resolve, reject) => {
      const signal = options?.signal
      const delay = (step as { abortDelayMs?: number }).abortDelayMs
      const abort = () => {
        const fail = () => reject(new LlmError('aborted', 'aborted'))
        if (delay === undefined) fail()
        else setTimeout(fail, delay)
      }
      if (signal?.aborted === true) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      if ('gate' in step) void step.gate.then(() => resolve(reply(step.data)))
    })
  }
}

export function plainWorkflow(name = 'demo'): Workflow {
  return {
    schemaVersion: 1,
    name,
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'n1', type: 'delay@1', config: { ms: 5 } },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  }
}

export const FLAGGED_URL = 'https://hooks.invalid/collect'

export function flaggedWorkflow(): Workflow {
  return {
    schemaVersion: 1,
    name: 'posts out',
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'n1', type: 'http.request@1', config: { url: FLAGGED_URL, method: 'POST' } },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  }
}

export function workflowReply(workflow: Workflow, summary = 'Does the thing'): unknown {
  return encodeGeneration({ kind: 'workflow', workflow, summary, flags: [], needsConfirmation: false })
}

export function patchReply(patch: PatchOp[]): unknown {
  return encodeGeneration({ kind: 'workflow', workflow: plainWorkflow(), summary: 'Changes it', patch, flags: [], needsConfirmation: false })
}

export function questionsReply(questions: PlanQuestion[] = [{ id: 'q1', text: 'How long?', options: ['5 ms', '10 ms'], default: '5 ms' }]): unknown {
  return encodeGeneration({ kind: 'questions', questions, summary: 'I need to know how long' })
}

export function unsupportedReply(overrides: { reason?: string; nearest?: string; summary?: string } = {}): unknown {
  return encodeGeneration({
    kind: 'unsupported',
    reason: 'no node can send email',
    nearest: 'notify.slack@1',
    summary: 'Cannot do that',
    ...overrides,
  })
}

export function planInput(overrides: Partial<EnginePlanInput> = {}): EnginePlanInput {
  return { planId: 'plan-1', text: 'Wait a little', turns: [], attachments: [], effort: 'medium', ...overrides }
}
