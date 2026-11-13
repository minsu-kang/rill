import Type from 'typebox'

export type Cell = string | number | boolean | null

const FORMULA_START = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export const CellSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])

export function isFormulaLike(text: string): boolean {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)
}

export function neutralise(cell: Cell): string {
  if (cell === null) return ''
  const text = String(cell)
  return typeof cell === 'string' && isFormulaLike(text) ? `'${text}` : text
}
