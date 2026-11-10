import type { Journal, JournalEntry, NodeContext } from '../src/types'

export function memoryJournal(): Journal & { entries: Map<string, JournalEntry> } {
  const entries = new Map<string, JournalEntry>()
  return {
    entries,
    get: (key) => entries.get(key),
    put: (key, state, data) => {
      entries.set(key, { state, data: data ?? entries.get(key)?.data ?? null })
    },
  }
}

export function makeCtx(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    runId: 'r1',
    nodeId: 'n1',
    attempt: 1,
    dryRun: false,
    idempotencyKey: 'r1:n1',
    journal: memoryJournal(),
    ...overrides,
  }
}
