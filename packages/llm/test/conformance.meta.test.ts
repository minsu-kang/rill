import { describe, expect, it } from 'vitest'
import { conformanceCases } from './conformance'
import { referenceConformance } from './reference-conformance'
import type { ReferenceFault } from './reference-provider'
import type { ReferenceVariant } from './reference-wire'

async function failures(fault: ReferenceFault, variant: ReferenceVariant = 'full'): Promise<string[]> {
  const failed: string[] = []
  for (const entry of conformanceCases(referenceConformance(fault, variant))) {
    try {
      await entry.run()
    } catch {
      failed.push(entry.name)
    }
  }
  return failed
}

describe('the conformance suite catches adapters that break a rule', () => {
  it.each<[ReferenceFault, string[]]>([
    ['retry-after-output', ['nothing is retried once the first event has arrived']],
    ['leak-key', ['auth: rejected once']],
    ['ignore-effort', ['effort: every level']],
    ['no-dispose', ['text and schema', 'deadline']],
    ['retry-invalid-request', ['invalid request and context too long']],
    ['swallow-truncation', ['truncated and refused']],
    ['wrong-usage', ['text and schema']],
    ['abort-as-connection', ['abort during the call', 'deadline']],
    ['drop-pdf', ['PDF']],
    ['key-in-body', ['text and schema']],
    ['sleep-past-deadline', ['a wait that does not fit the deadline']],
  ])('fault %s', async (fault, expected) => {
    const failed = await failures(fault)
    for (const part of expected) expect(failed.some((name) => name.includes(part)), `${fault}: no failing case mentions "${part}" (failed: ${failed.join(' | ')})`).toBe(true)
  })

  it('reports no failure for the healthy adapters, so the checks above are meaningful', async () => {
    for (const variant of ['full', 'plain'] as const) {
      const failed: string[] = []
      for (const entry of conformanceCases(referenceConformance(undefined, variant))) await entry.run().catch(() => failed.push(entry.name))
      expect(failed).toEqual([])
    }
  })

  it('names the mode in every per-mode case', () => {
    const names = conformanceCases(referenceConformance()).map((entry) => entry.name)
    expect(names.filter((name) => name.startsWith('[json]')).length).toBe(names.filter((name) => name.startsWith('[sse]')).length)
    expect(new Set(names).size).toBe(names.length)
  })
})
