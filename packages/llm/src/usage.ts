import { LlmError, type LlmUsage } from './types'

export const MAX_USAGE_TOKENS = 1e9

export function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < MAX_USAGE_TOKENS
}

export interface UsageParts {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning?: number
  inputIncludesCache: boolean
}

function impossible(field: string, value: unknown, why: string): LlmError {
  return new LlmError('invalid_output', `the model provider reported an impossible ${field} token count (${String(value)}): ${why}`)
}

export function normaliseUsage(parts: UsageParts): LlmUsage {
  const fields = { input: parts.input, cacheRead: parts.cacheRead, cacheWrite: parts.cacheWrite, output: parts.output, reasoning: parts.reasoning ?? 0 }
  for (const [field, value] of Object.entries(fields)) {
    if (!isTokenCount(value)) throw impossible(field, value, 'it must be a whole number of tokens that is not negative')
    if (!Number.isInteger(value)) throw impossible(field, value, 'it must be a whole number of tokens')
  }
  const cached = parts.cacheRead + parts.cacheWrite
  if (parts.inputIncludesCache && cached > parts.input) {
    throw impossible('cache', cached, `the cache buckets are larger than the ${parts.input} input tokens that include them`)
  }
  return {
    inputTokens: parts.inputIncludesCache ? parts.input - cached : parts.input,
    outputTokens: parts.output + fields.reasoning,
    cacheReadInputTokens: parts.cacheRead,
    cacheCreationInputTokens: parts.cacheWrite,
  }
}
