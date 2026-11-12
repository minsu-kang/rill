import type { PlanTurn } from '@rill/protocol'
import type { ConversationEntry } from './conversation'

export const MAX_TURNS = 40
const MAX_TEXT = 8000
const MAX_ATTACHMENTS = 5
const MAX_ANSWERS = 10

function cap(text: string): string {
  if (text.length <= MAX_TEXT) return text
  const last = text.charCodeAt(MAX_TEXT - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_TEXT - 1 : MAX_TEXT)
}

function turnOf(entry: ConversationEntry): PlanTurn {
  if (entry.role === 'assistant') return { role: 'assistant', text: cap(entry.result.summary), result: entry.result }
  const turn: PlanTurn = { role: 'user', text: cap(entry.text) }
  if (entry.attachments.length > 0) turn.attachments = entry.attachments.slice(0, MAX_ATTACHMENTS).map((item) => ({ ...item }))
  if (entry.answers !== undefined) {
    turn.answers = Object.fromEntries(Object.entries(entry.answers).slice(0, MAX_ANSWERS).map(([id, answer]) => [id, cap(answer)]))
  }
  return turn
}

export function buildTurns(entries: readonly ConversationEntry[]): PlanTurn[] {
  const turns = entries.slice(-MAX_TURNS).map(turnOf)
  let start = 0
  while (turns[start]?.role === 'assistant') start += 1
  return turns.slice(start)
}
