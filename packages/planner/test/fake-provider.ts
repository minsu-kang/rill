import { LlmError, type LlmCallOptions, type LlmProvider, type LlmRequest, type LlmResult, type LlmUsage } from '@rill/llm'

export type Step =
  | { data: unknown; model?: string; usage?: Partial<LlmUsage>; fallbackUsed?: boolean }
  | { error: LlmError }
  | { wait: true }

export interface Recorded {
  request: LlmRequest
  options: LlmCallOptions | undefined
}

export const SONNET = 'claude-sonnet-5-5'

export function usage(partial: Partial<LlmUsage> = {}): LlmUsage {
  return { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...partial }
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake'
  readonly calls: Recorded[] = []
  private readonly steps: Step[]

  constructor(steps: Step[]) {
    this.steps = [...steps]
  }

  get remaining(): number {
    return this.steps.length
  }

  async generate(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> {
    this.calls.push({ request: structuredClone(request), options: options === undefined ? undefined : { ...options } })
    const step = this.steps.shift()
    if (step === undefined) throw new Error(`fake provider: no scripted step for call ${this.calls.length}`)
    if ('error' in step) throw step.error
    if ('wait' in step) {
      return new Promise<LlmResult>((_, reject) => {
        const signal = options?.signal
        const abort = () => reject(new LlmError('aborted', 'aborted'))
        if (signal?.aborted === true) abort()
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const model = step.model ?? SONNET
    return {
      data: structuredClone(step.data),
      usage: usage(step.usage),
      model,
      requestedModel: SONNET,
      stopReason: 'end_turn',
      durationMs: 5,
      fallbackUsed: step.fallbackUsed ?? false,
      servedModels: [model],
    }
  }
}
