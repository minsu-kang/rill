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

  it('sees its own protected row and does not write it again', async () => {
    const journal = memoryJournal()
    const row = ['=1+1', '-5', '+x']
    writeFileSync(file, 'old\n' + encodeRow(row))
    journal.put('runA:n1', 'intent', String('old\n'.length))
    await csvAppend.execute({ file, row }, makeCtx({ journal, idempotencyKey: 'runA:n1' }))
    expect(readFileSync(file, 'utf8')).toBe("old\n'=1+1,-5,'+x\n")
    expect(journal.get('runA:n1')?.state).toBe('done')
  })

  it('repairs a torn write of a protected row', async () => {
    const journal = memoryJournal()
    const row = ['=1+1', 'tail']
    writeFileSync(file, 'old\n' + encodeRow(row).slice(0, 4))
    journal.put('runA:n1', 'intent', String('old\n'.length))
    await csvAppend.execute({ file, row }, makeCtx({ journal, idempotencyKey: 'runA:n1' }))
    expect(readFileSync(file, 'utf8')).toBe("old\n'=1+1,tail\n")
  })

  it('writes a protected row once when the same run is retried after it was written but not journaled', async () => {
    const journal = memoryJournal()
    const row = ['@cmd']
    await csvAppend.execute({ file, row }, makeCtx({ journal, idempotencyKey: 'runA:n1' }))
    journal.entries.set('runA:n1', { state: 'intent', data: '0' })
    await csvAppend.execute({ file, row }, makeCtx({ journal, idempotencyKey: 'runA:n1', attempt: 2 }))
    expect(readFileSync(file, 'utf8')).toBe("'@cmd\n")
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
