import { emptyExchange, type ExchangeParser, type ParsedExchange } from '../descriptor'
import { SseParser } from '../sse'
import { zeroUsage } from '../usage'
import { isRecord, readEvent, readUsage, stopReasonOf, terminalOf, type Json, type Terminal } from './reply'

function lastTerminal(text: string): Terminal | undefined {
  const parser = new SseParser()
  let last: Terminal | undefined
  try {
    for (const event of [...parser.push(text), ...parser.end()]) {
      const parsed = readEvent(event)
      const terminal = parsed === undefined ? undefined : terminalOf(parsed)
      if (terminal !== undefined) last = terminal
    }
  } catch {
    return last
  }
  return last
}

function stopReason(response: Json, type: string | undefined): string | null {
  const status = typeof response.status === 'string' ? response.status : undefined
  if (type === 'response.incomplete' || status === 'incomplete') {
    const reason = isRecord(response.incomplete_details) && typeof response.incomplete_details.reason === 'string' ? response.incomplete_details.reason : undefined
    return stopReasonOf(reason) ?? 'incomplete'
  }
  if (type === 'response.completed' || status === 'completed') return 'end_turn'
  return status ?? null
}

function describeOutput(output: unknown, parsed: ParsedExchange): void {
  if (!Array.isArray(output)) return
  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== 'string') continue
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (isRecord(part) && typeof part.type === 'string') parsed.contentBlockTypes.push(part.type)
      continue
    }
    parsed.contentBlockTypes.push(item.type)
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const entry of item.summary) if (isRecord(entry) && typeof entry.text === 'string') parsed.thinkingChars += entry.text.length
    }
  }
}

function parse(text: string, success: boolean): ParsedExchange {
  const parsed = emptyExchange(null)
  if (text.trim() === '') {
    if (success) parsed.badReply = 'the reply body is empty'
    return parsed
  }
  let response: Json
  let type: string | undefined
  let json: unknown
  let isJson = true
  try {
    json = JSON.parse(text)
  } catch {
    isJson = false
  }
  if (isJson) {
    if (!isRecord(json)) {
      if (success) parsed.badReply = 'the reply is not a JSON object'
      return parsed
    }
    response = json
  } else {
    const terminal = lastTerminal(text)
    if (terminal === undefined) {
      if (success) parsed.badReply = 'the stream has no final event'
      return parsed
    }
    response = terminal.response
    type = terminal.type
  }
  if (success && isRecord(response.error)) {
    parsed.badReply = 'the reply carries an error object'
    return parsed
  }
  try {
    parsed.usage = readUsage(response.usage)
  } catch (error) {
    parsed.usage = zeroUsage()
    if (success) {
      parsed.badReply = (error as Error).message
      return parsed
    }
  }
  if (typeof response.model === 'string') parsed.model = response.model
  parsed.stopReason = stopReason(response, type)
  describeOutput(response.output, parsed)
  return parsed
}

export const grokExchange: ExchangeParser = { parse }
