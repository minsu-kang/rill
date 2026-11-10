import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { csvAppend, encodeRow } from '../src/nodes/csv-append'
import { makeCtx, memoryJournal } from './helpers'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-csvr-'))
  file = join(dir, 'ledger.csv')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('csv.append@1 resume', () => {
  it('keeps rows that another run appended after the crashed intent', async () => {
    const journal = memoryJournal()
    writeFileSync(file, 'old\n')
    journal.put('runA:n1', 'intent', String('old\n'.length))
    await csvAppend.execute({ file, row: ['B-row'] }, makeCtx({ idempotencyKey: 'runB:n1' }))
    await csvAppend.execute({ file, row: ['A-row'] }, makeCtx({ journal, idempotencyKey: 'runA:n1' }))
    expect(readFileSync(file, 'utf8')).toBe('old\nB-row\nA-row\n')
    expect(journal.get('runA:n1')?.state).toBe('done')
  })

  it('still repairs a torn write of its own row', async () => {
    const journal = memoryJournal()
    writeFileSync(file, 'old\n' + encodeRow(['A-row']).slice(0, 3))
    journal.put('runA:n1', 'intent', String('old\n'.length))
    await csvAppend.execute({ file, row: ['A-row'] }, makeCtx({ journal, idempotencyKey: 'runA:n1' }))
    expect(readFileSync(file, 'utf8')).toBe('old\nA-row\n')
  })

  it('finishes silently when the row is already in place followed by other rows', async () => {
    const journal = memoryJournal()
    writeFileSync(file, 'old\n' + encodeRow(['A-row']) + 'B-row\n')
    journal.put('runA:n1', 'intent', String('old\n'.length))
    await csvAppend.execute({ file, row: ['A-row'] }, makeCtx({ journal, idempotencyKey: 'runA:n1' }))
    expect(readFileSync(file, 'utf8')).toBe('old\nA-row\nB-row\n')
    expect(journal.get('runA:n1')?.state).toBe('done')
  })
})
