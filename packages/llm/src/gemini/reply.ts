import { normaliseUsage } from '../usage'
import { LlmError, type LlmErrorOptions, type LlmResult, type LlmUsage } from '../types'
import { eventError } from './errors'

export interface Terminal {
  status: string
  model: string | undefined
  usage: unknown
  errors: unknown
  steps: unknown
}

export interface StreamFailure {
  code: string | undefined
  message: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export function terminalOf(interaction: unknown): Terminal | undefined {
  if (!isRecord(interaction)) return undefined
  const status = stringOf(interaction['status'])
  if (status === undefined) return undefined
  return { status, model: stringOf(interaction['model']), usage: interaction['usage'], errors: interaction['errors'], steps: interaction['steps'] }
}

export class InteractionReader {
  readonly stepTypes: string[] = []
  model: string | undefined
  terminal: Terminal | undefined
  failure: StreamFailure | undefined
  private readonly chunks: string[] = []

  get text(): string {
    return this.chunks.join('')
  }

  push(event: unknown): void {
    if (!isRecord(event)) return
    switch (event['event_type']) {
      case 'interaction.created': {
        const interaction = event['interaction']
        this.model ??= isRecord(interaction) ? stringOf(interaction['model']) : undefined
        return
      }
      case 'step.start': {
        const type = isRecord(event['step']) ? stringOf(event['step']['type']) : undefined
        if (type !== undefined) this.stepTypes.push(type)
        return
      }
      case 'step.delta': {
        const delta = event['delta']
        if (isRecord(delta) && delta['type'] === 'text' && typeof delta['text'] === 'string') this.chunks.push(delta['text'])
        return
      }
      case 'interaction.completed':
        this.terminal = terminalOf(event['interaction']) ?? this.terminal
        return
      case 'error': {
        const error = event['error']
        this.failure ??= { code: isRecord(error) ? stringOf(error['code']) : undefined, message: isRecord(error) ? stringOf(error['message']) : undefined }
        return
      }
    }
  }
}

export function usageOf(raw: unknown): LlmUsage {
  if (!isRecord(raw)) throw new LlmError('invalid_output', 'the model provider reported no token usage')
  if (raw['total_input_tokens'] === undefined) throw new LlmError('invalid_output', 'the model provider reported no input token count')
  return normaliseUsage({
    input: raw['total_input_tokens'] as number,
    cacheRead: (raw['total_cached_tokens'] ?? 0) as number,
    cacheWrite: 0,
    output: (raw['total_output_tokens'] ?? 0) as number,
    reasoning: (raw['total_thought_tokens'] ?? 0) as number,
    inputIncludesCache: true,
  })
}

function tryUsage(raw: unknown): LlmUsage | undefined {
  try {
    return usageOf(raw)
  } catch {
    return undefined
  }
}

function textOfSteps(steps: unknown): string {
  if (!Array.isArray(steps)) return ''
  return steps
    .flatMap((step) => (isRecord(step) && step['type'] === 'model_output' && Array.isArray(step['content']) ? step['content'] : []))
    .flatMap((part) => (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []))
    .join('')
}

function failedInteraction(errors: unknown, secrets: readonly string[], billed: LlmErrorOptions): LlmError {
  const first = Array.isArray(errors) ? errors[0] : undefined
  if (!isRecord(first)) return new LlmError('unknown', 'the model provider reported that the interaction failed', billed)
  return eventError(stringOf(first['code']), stringOf(first['message']), secrets, billed)
}

export function interactionResult(reader: InteractionReader, requestedModel: string, startedAt: number, secrets: readonly string[]): LlmResult {
  const { terminal } = reader
  if (terminal === undefined) throw new LlmError('connection', 'the connection to the model provider ended before the reply was complete')
  const model = terminal.model ?? reader.model ?? requestedModel
  const servedModels = [model]
  const status = terminal.status
  const early = tryUsage(terminal.usage)
  const billedEarly: LlmErrorOptions = { ...(early === undefined ? {} : { usage: early }), model, servedModels }
  if (status === 'incomplete' || status === 'requires_continuation') {
    throw new LlmError('truncated', 'the model reply was cut off before it finished; raise maxTokens or shorten the input', billedEarly)
  }
  if (status === 'cancelled') throw new LlmError('unknown', 'the model provider cancelled the request', billedEarly)
  if (status === 'failed') throw failedInteraction(terminal.errors, secrets, billedEarly)
  if (status !== 'completed') {
    throw new LlmError('invalid_output', `the model provider ended the reply with an unexpected status (${status})`, billedEarly)
  }
  const usage = usageOf(terminal.usage)
  const billed: LlmErrorOptions = { usage, model, servedModels }
  const text = reader.text === '' ? textOfSteps(terminal.steps) : reader.text
  if (text === '') throw new LlmError('invalid_output', 'the model reply had no text', billed)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new LlmError('invalid_output', 'the model reply was not valid JSON', { cause: error, ...billed })
  }
  return { data, usage, model, requestedModel, stopReason: status, durationMs: Date.now() - startedAt, fallbackUsed: model !== requestedModel, servedModels }
}
