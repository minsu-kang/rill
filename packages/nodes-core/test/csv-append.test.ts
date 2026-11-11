import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { csvAppend, encodeRow } from '../src/nodes/csv-append'
import { makeCtx, memoryJournal } from './helpers'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-csv-'))
  file = join(dir, 'ledger.csv')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('encodeRow', () => {
  it('quotes cells that contain commas, quotes or newlines', () => {
    expect(encodeRow(['a,b', 'say "hi"', 3, null, true, 'line\nbreak'])).toBe(
      '"a,b","say ""hi""",3,,true,"line\nbreak"\n',
    )
  })
})

describe('encodeRow formula protection', () => {
  it.each([
    ['=', '=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+', '+1+cmd|calc', "'+1+cmd|calc"],
    ['-', '-2+3', "'-2+3"],
    ['@', '@SUM(1)', "'@SUM(1)"],
    ['a tab', '\t=1', "'\t=1"],
    ['a carriage return', '\r=1', '"\'\r=1"'],
  ])('prefixes a string cell that starts with %s with a single quote', (_name, cell, expected) => {
    expect(encodeRow([cell])).toBe(`${expected}\n`)
  })

  it('still quotes a protected cell that holds a comma, a quote or a line break', () => {
    expect(encodeRow(['=HYPERLINK("http://x.test","a,b")'])).toBe('"\'=HYPERLINK(""http://x.test"",""a,b"")"\n')
    expect(encodeRow(['-a\nb'])).toBe('"\'-a\nb"\n')
  })

  it('leaves a string that is only a plain number as it is', () => {
    for (const cell of ['-12.5', '+3', '-0', '+0.5', '-.5', '-1e5', '+2.5E-3', '-7']) expect(encodeRow([cell]), cell).toBe(`${cell}\n`)
  })

  it('protects a string that only starts like a number', () => {
    for (const cell of ['-12.5.1', '+3-2', '-1,234', '--1', '+', '-', '-1e', '-1 ', '+1\t', '-12abc']) {
      expect(encodeRow([cell]), cell).toBe(cell.includes(',') ? `"'${cell}"\n` : `'${cell}\n`)
    }
  })

  it('does not touch a cell that merely contains a formula character', () => {
    for (const cell of ['a=b', 'x+y', 'a-b', 'me@x.test', ' =1', '', "'=1", '\u2212 5']) expect(encodeRow([cell]), cell).toBe(`${cell}\n`)
  })

  it('never changes numbers, booleans or null', () => {
    expect(encodeRow([-12.5, 3, -0, 1e21, -1e-7, true, false, null])).toBe(`${String(-12.5)},3,0,${String(1e21)},${String(-1e-7)},true,false,\n`)
  })

  it('protects every cell of a row on its own', () => {
    expect(encodeRow(['=1', 'ok', '-3', '@a', 2])).toBe("'=1,ok,-3,'@a,2\n")
  })
})

describe('csv.append@1', () => {
  it('is declared idempotent', () => {
    expect(csvAppend.type).toBe('csv.append@1')
    expect(csvAppend.sideEffect).toBe('idempotent')
  })

  it('appends one row and marks the journal done', async () => {
    const ctx = makeCtx()
    const output = await csvAppend.execute({ file, row: ['a', 1] }, ctx)
    expect(output).toEqual({ file, written: true })
    expect(readFileSync(file, 'utf8')).toBe('a,1\n')
    expect(ctx.journal.get('r1:n1')?.state).toBe('done')
  })

  it('writes a formula cell with the protective quote, and says so in its description', async () => {
    await csvAppend.execute({ file, row: ['=1+1', 'ok', '-12.5'] }, makeCtx())
    expect(readFileSync(file, 'utf8')).toBe("'=1+1,ok,-12.5\n")
    expect(csvAppend.description).toMatch(/leading single quote/)
  })

  it('creates missing parent directories', async () => {
    const nested = join(dir, 'a', 'b', 'x.csv')
    await csvAppend.execute({ file: nested, row: ['x'] }, makeCtx())
    expect(readFileSync(nested, 'utf8')).toBe('x\n')
  })

  it('does not write twice for the same idempotency key', async () => {
    const journal = memoryJournal()
    await csvAppend.execute({ file, row: ['a', 1] }, makeCtx({ journal }))
    await csvAppend.execute({ file, row: ['a', 1] }, makeCtx({ journal, attempt: 2 }))
    expect(readFileSync(file, 'utf8')).toBe('a,1\n')
  })

  it('treats done as final even if the file was removed afterwards', async () => {
    const journal = memoryJournal()
    await csvAppend.execute({ file, row: ['a'] }, makeCtx({ journal }))
    rmSync(file)
    await csvAppend.execute({ file, row: ['a'] }, makeCtx({ journal, attempt: 2 }))
    expect(existsSync(file)).toBe(false)
  })

  it('writes separate rows for different keys', async () => {
    const journal = memoryJournal()
    await csvAppend.execute({ file, row: ['a'] }, makeCtx({ journal, idempotencyKey: 'r1:n1' }))
    await csvAppend.execute({ file, row: ['b'] }, makeCtx({ journal, idempotencyKey: 'r2:n1' }))
    expect(readFileSync(file, 'utf8')).toBe('a\nb\n')
  })

  it('recovers after a crash between the write and the journal update', async () => {
    const journal = memoryJournal()
    writeFileSync(file, 'existing\n')
    journal.put('r1:n1', 'intent', String('existing\n'.length))
    writeFileSync(file, 'existing\n' + encodeRow(['a', 1]))
    await csvAppend.execute({ file, row: ['a', 1] }, makeCtx({ journal }))
    expect(readFileSync(file, 'utf8')).toBe('existing\na,1\n')
    expect(journal.get('r1:n1')?.state).toBe('done')
  })

  it('keeps rows other writers appended after an already written row', async () => {
    const journal = memoryJournal()
    journal.put('r1:n1', 'intent', '0')
    writeFileSync(file, encodeRow(['a', 1]) + 'other\n')
    await csvAppend.execute({ file, row: ['a', 1] }, makeCtx({ journal }))
    expect(readFileSync(file, 'utf8')).toBe('a,1\nother\n')
  })

  it('repairs a torn partial write', async () => {
    const journal = memoryJournal()
    journal.put('r1:n1', 'intent', '0')
    writeFileSync(file, encodeRow(['a', 1]).slice(0, 2))
    await csvAppend.execute({ file, row: ['a', 1] }, makeCtx({ journal }))
    expect(readFileSync(file, 'utf8')).toBe('a,1\n')
  })

  it('writes nothing in a dry run', async () => {
    const ctx = makeCtx({ dryRun: true })
    const output = await csvAppend.execute({ file, row: ['a'] }, ctx)
    expect(output).toEqual({ file, written: false })
    expect(existsSync(file)).toBe(false)
    expect(ctx.journal.get('r1:n1')).toBeUndefined()
  })
})
