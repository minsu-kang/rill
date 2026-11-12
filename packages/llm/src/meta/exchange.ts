import { emptyExchange, type ExchangeParser, type ParsedExchange } from '../descriptor'
import { SseParser, type SseEvent } from '../sse'
import { LlmError } from '../types'
import { ChatAccumulator, readUsage, type ChatReply } from './reply'

const READ_CHUNK = 64 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function fill(parsed: ParsedExchange, reply: Pick<ChatReply, 'model' | 'usage' | 'content' | 'refusal'> & { finishReason: string | null }, success: boolean): ParsedExchange {
  if (reply.model !== null) parsed.model = reply.model
  if (reply.finishReason !== null) parsed.stopReason = reply.finishReason
  if (reply.content !== '') parsed.contentBlockTypes.push('text')
  if (reply.refusal !== '') parsed.contentBlockTypes.push('refusal')
  const reading = readUsage(reply.usage)
  if (reading.usage !== undefined) parsed.usage = reading.usage
  else if (success) parsed.badReply = reading.problem
  return parsed
}

function parseJson(body: Record<string, unknown>, success: boolean): ParsedExchange {
  const parsed = emptyExchange(null)
  const choice = Array.isArray(body['choices']) ? body['choices'].find(isRecord) : undefined
  if (success && choice === undefined) {
    parsed.badReply = 'the reply has no choices'
    return parsed
  }
  const message = isRecord(choice?.['message']) ? choice['message'] : {}
  const finish = typeof choice?.['finish_reason'] === 'string' ? choice['finish_reason'] : null
  return fill(
    parsed,
    {
      model: typeof body['model'] === 'string' ? body['model'] : null,
      finishReason: finish,
      content: typeof message['content'] === 'string' ? message['content'] : '',
      refusal: typeof message['refusal'] === 'string' ? message['refusal'] : '',
      usage: body['usage'],
    },
    success,
  )
}

function parseStream(text: string, success: boolean): ParsedExchange {
  const parsed = emptyExchange(null)
  const accumulator = new ChatAccumulator()
  const events: SseEvent[] = []
  try {
    const reader = new SseParser()
    for (let start = 0; start < text.length; start += READ_CHUNK) events.push(...reader.push(text.slice(start, start + READ_CHUNK)))
    events.push(...reader.end())
    for (const event of events) if (event.data !== '[DONE]') accumulator.push(event)
    return fill(parsed, accumulator.finish(), success)
  } catch (error) {
    if (success) parsed.badReply = error instanceof LlmError ? error.message : 'the stream could not be read'
    return parsed
  }
}

function parseMeta(text: string, success: boolean): ParsedExchange {
  if (text.trim() === '') {
    const parsed = emptyExchange(null)
    if (success) parsed.badReply = 'the reply body is empty'
    return parsed
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return parseStream(text, success)
  }
  if (!isRecord(body)) {
    const parsed = emptyExchange(null)
    if (success) parsed.badReply = 'the reply is not a JSON object'
    return parsed
  }
  return parseJson(body, success)
}

export const metaExchange: ExchangeParser = { parse: parseMeta }
