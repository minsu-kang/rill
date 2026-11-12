import { emptyExchange, type ExchangeParser, type ParsedExchange } from '../descriptor'
import { SseParser } from '../sse'
import { LlmError } from '../types'
import { InteractionReader, terminalOf, usageOf } from './reply'

const DONE = '[DONE]'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function foldStream(reader: InteractionReader, text: string): boolean {
  const parser = new SseParser()
  const events = [...parser.push(text), ...parser.end()]
  for (const event of events) {
    if (event.data === DONE) break
    reader.push(jsonOf(event.data))
  }
  return events.length > 0
}

function foldInteraction(reader: InteractionReader, value: Record<string, unknown>): boolean {
  const terminal = terminalOf(value)
  if (terminal === undefined) return false
  reader.terminal = terminal
  if (Array.isArray(value['steps'])) {
    for (const step of value['steps']) if (isRecord(step) && typeof step['type'] === 'string') reader.stepTypes.push(step['type'])
  }
  return true
}

function parseGeminiBody(text: string, success: boolean): ParsedExchange {
  const parsed = emptyExchange(null)
  const trimmed = text.trim()
  if (trimmed === '') {
    if (success) parsed.badReply = 'the reply body is empty'
    return parsed
  }
  const reader = new InteractionReader()
  let understood: boolean
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const value = jsonOf(trimmed)
    understood = isRecord(value) && foldInteraction(reader, value)
    if (!understood && success) parsed.badReply = 'the reply is not an interaction'
  } else {
    understood = foldStream(reader, text)
    if (!understood && success) parsed.badReply = 'the reply is not a stream of events'
  }
  if (!understood) return parsed
  const { terminal } = reader
  parsed.model = terminal?.model ?? reader.model ?? null
  parsed.stopReason = terminal?.status ?? null
  parsed.contentBlockTypes = reader.stepTypes
  if (terminal !== undefined) {
    try {
      parsed.usage = usageOf(terminal.usage)
    } catch (error) {
      if (success) parsed.badReply = `the reply has invalid usage: ${error instanceof LlmError ? error.message : 'unreadable'}`
    }
  }
  if (success && parsed.badReply === null) {
    if (reader.failure !== undefined) parsed.badReply = `the stream carried an error event (${reader.failure.code ?? 'no code'})`
    else if (terminal === undefined) parsed.badReply = 'the stream ended without its final event'
  }
  return parsed
}

export const geminiExchange: ExchangeParser = { parse: parseGeminiBody }
