import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Type from 'typebox'
import { defineAction } from '../types'

type Cell = string | number | boolean | null

function encodeCell(cell: Cell): string {
  if (cell === null) return ''
  const text = String(cell)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function encodeRow(cells: Cell[]): string {
  return cells.map(encodeCell).join(',') + '\n'
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

function sizeOf(file: string): number {
  return existsSync(file) ? statSync(file).size : 0
}

function rowPresentAt(file: string, offset: number, bytes: Buffer): boolean {
  if (sizeOf(file) < offset + bytes.length) return false
  const fd = openSync(file, 'r')
  try {
    const actual = Buffer.alloc(bytes.length)
    readSync(fd, actual, 0, bytes.length, offset)
    return actual.equals(bytes)
  } finally {
    closeSync(fd)
  }
}

function appendDurably(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const CellSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])

export const csvAppend = defineAction({
  type: 'csv.append@1',
  title: 'Append CSV row',
  description: 'Appends one row to a CSV file, exactly once even if the run is retried or resumed.',
  sideEffect: 'idempotent',
  configSchema: Type.Object(
    { file: Type.String({ minLength: 1 }), row: Type.Array(CellSchema, { minItems: 1 }) },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object({ file: Type.String(), written: Type.Boolean() }),
  execute: async (config, ctx) => {
    const file = expandHome(config.file)
    if (ctx.dryRun) return { file, written: false }
    const entry = ctx.journal.get(ctx.idempotencyKey)
    if (entry?.state === 'done') return { file, written: true }
    const bytes = Buffer.from(encodeRow(config.row), 'utf8')
    const size = sizeOf(file)
    if (!entry) {
      ctx.journal.put(ctx.idempotencyKey, 'intent', String(size))
    } else {
      const offset = Number(entry.data)
      if (rowPresentAt(file, offset, bytes)) {
        ctx.journal.put(ctx.idempotencyKey, 'done')
        return { file, written: true }
      }
      if (size > offset) truncateSync(file, offset)
    }
    appendDurably(file, bytes)
    ctx.journal.put(ctx.idempotencyKey, 'done')
    return { file, written: true }
  },
})
