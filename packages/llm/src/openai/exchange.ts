import { emptyExchange, type ExchangeParser, type ParsedExchange } from '../descriptor'
import { SseParser } from '../sse'
import { isRecord, stopReasonOf, usageOf, viewOf } from './reply'

const TERMINAL: ReadonlySet<string> = new Set(['response.completed', 'response.incomplete', 'response.failed'])

type Candidate = { kind: 'response'; response: unknown } | { kind: 'stream-without-end' } | { kind: 'not-json' } | { kind: 'empty' }

function fromStream(body: string): Candidate {
  const parser = new SseParser()
  let events
  try {
    events = [...parser.push(body), ...parser.end()]
  } catch {
    return { kind: 'not-json' }
  }
  let sawEvent = false
  for (const event of events) {
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      continue
    }
    sawEvent = true
    if (isRecord(data) && typeof data.type === 'string' && TERMINAL.has(data.type)) return { kind: 'response', response: data.response }
  }
  return sawEvent ? { kind: 'stream-without-end' } : { kind: 'not-json' }
}

function candidateOf(body: string): Candidate {
  if (body.trim() === '') return { kind: 'empty' }
  try {
    return { kind: 'response', response: JSON.parse(body) as unknown }
  } catch {
    return fromStream(body)
  }
}

function textLength(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value.reduce<number>((sum, entry) => sum + (isRecord(entry) && typeof entry.text === 'string' ? entry.text.length : 0), 0)
}

function describe(parsed: ParsedExchange, response: Record<string, unknown>): void {
  const output: unknown[] = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== 'string') continue
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (isRecord(part) && typeof part.type === 'string') parsed.contentBlockTypes.push(part.type)
    } else parsed.contentBlockTypes.push(item.type)
    if (item.type === 'reasoning') parsed.thinkingChars += textLength(item.summary) + textLength(item.content)
  }
}

function parseOpenAiBody(body: string, success: boolean): ParsedExchange {
  const parsed = emptyExchange(null)
  const candidate = candidateOf(body)
  if (candidate.kind !== 'response') {
    if (success) {
      parsed.badReply =
        candidate.kind === 'empty'
          ? 'the reply body is empty'
          : candidate.kind === 'stream-without-end'
            ? 'the reply stream ended without a final event'
            : 'the reply is not JSON'
    }
    return parsed
  }
  const response = candidate.response
  if (!isRecord(response)) {
    if (success) parsed.badReply = 'the reply is not a JSON object'
    return parsed
  }
  const view = viewOf(response)
  if (view === undefined) {
    if (success) parsed.badReply = 'the reply has no output array'
    return parsed
  }
  if (view.model !== null) parsed.model = view.model
  parsed.stopReason = stopReasonOf(view)
  describe(parsed, response)
  try {
    parsed.usage = usageOf(response.usage)
  } catch {
    if (success && (view.status === 'completed' || view.status === 'incomplete')) parsed.badReply = 'the reply has an invalid usage'
  }
  if (success && view.status !== 'completed' && view.status !== 'incomplete') {
    parsed.badReply = `the response did not finish (${view.status}${view.error?.code == null ? '' : `, ${view.error.code}`})`
  }
  return parsed
}

export const openaiExchange: ExchangeParser = { parse: parseOpenAiBody }
