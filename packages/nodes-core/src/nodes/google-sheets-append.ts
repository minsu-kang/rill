import Type from 'typebox'
import { accessTokenOf } from '../account-connection'
import { UPDATED_RANGE_MAX, RowSchema, assertConfig, encodePathPart, postRow, untrustedText } from '../spreadsheet-api'
import { defineAction } from '../types'

const ORIGIN = 'https://sheets.googleapis.com/v4/spreadsheets/'
const QUERY = 'valueInputOption=RAW&insertDataOption=INSERT_ROWS'
const DEFAULT_RANGE = 'Sheet1'

const configSchema = Type.Object(
  {
    connection: Type.String({ minLength: 1 }),
    spreadsheetId: Type.String({ minLength: 20, maxLength: 100, pattern: '^[A-Za-z0-9_-]{20,100}$' }),
    range: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "^[\\p{L}\\p{N}_ .'!:$-]{1,120}$", default: DEFAULT_RANGE })),
    values: RowSchema,
  },
  { additionalProperties: false },
)

function answeredRange(body: unknown): unknown {
  let value = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const updates = typeof value === 'object' && value !== null ? (value as { updates?: unknown }).updates : undefined
  return typeof updates === 'object' && updates !== null ? (updates as { updatedRange?: unknown }).updatedRange : undefined
}

export const googleSheetsAppend = defineAction({
  type: 'google.sheets.append@1',
  title: 'Append row to Google Sheets',
  description:
    "Appends one row to a Google Sheets spreadsheet in the user's own Google account, through a google connection. A crash right after sending can make a resumed run add the row twice. A retry after a server error, a timeout or a network error can do the same. Needs the spreadsheetId (the long id in the spreadsheet address, never its title): ask the user for it when it was not given and never invent one. The range is a sheet name or an A1 range such as Sheet1 or Receipts!A:D and defaults to Sheet1. The values are one row of 1 to 50 cells, stored as typed: a text that starts with = is kept as text and not evaluated as a formula.",
  sideEffect: 'external',
  roles: { '/connection': 'connection', '/spreadsheetId': 'recipient' },
  configSchema,
  outputSchema: Type.Object({ appended: Type.Boolean(), updatedRange: Type.String({ maxLength: UPDATED_RANGE_MAX }) }),
  execute: async (config, ctx) => {
    assertConfig(configSchema, config)
    if (ctx.dryRun) return { appended: false, updatedRange: '' }
    const token = accessTokenOf(ctx.connections, config.connection, 'google')
    const url = `${ORIGIN}${encodePathPart(config.spreadsheetId)}/values/${encodePathPart(config.range ?? DEFAULT_RANGE)}:append?${QUERY}`
    const body = await postRow(url, token, config.values)
    return { appended: true, updatedRange: untrustedText(answeredRange(body), token, UPDATED_RANGE_MAX) }
  },
})
