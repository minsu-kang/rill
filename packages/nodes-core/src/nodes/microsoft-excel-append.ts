import Type from 'typebox'
import { neutralise, type Cell } from '../cells'
import { RowSchema, assertConfig, encodePathPart, postRowRenewing } from '../spreadsheet-api'
import { defineAction } from '../types'

const ORIGIN = 'https://graph.microsoft.com/v1.0/me/drive/root:/'
const FILE_PATH = '^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?=.*[^/]\\.[xX][lL][sS][xX]$)[^\\p{C}\\\\:*?"<>|#%]{1,400}$'
const TABLE = '^[\\p{L}_][\\p{L}\\p{N}_. -]{0,254}$'

const configSchema = Type.Object(
  {
    connection: Type.String({ minLength: 1 }),
    filePath: Type.String({ minLength: 1, maxLength: 400, pattern: FILE_PATH }),
    table: Type.String({ minLength: 1, maxLength: 255, pattern: TABLE }),
    values: RowSchema,
  },
  { additionalProperties: false },
)

function excelCell(cell: Cell): string | number | boolean {
  return typeof cell === 'string' ? neutralise(cell) : cell === null ? '' : cell
}

export const microsoftExcelAppend = defineAction({
  type: 'microsoft.excel.append@1',
  title: 'Append row to Excel',
  description:
    "Appends one row to an Excel table in a .xlsx workbook in the user's own OneDrive, through a microsoft connection. A crash right after sending can make a resumed run add the row twice. A retry after a server error, a timeout or a network error can do the same. Needs the OneDrive path of the workbook, for example Receipts/ledger.xlsx, and the name of a table that already exists in it: ask the user for both when they were not given and never invent them. The values are one row of 1 to 50 cells. A text that starts with =, +, -, @, a tab or a carriage return gets a leading single quote so Excel shows it as text; plain numbers stay as they are.",
  sideEffect: 'external',
  roles: { '/connection': 'connection', '/filePath': 'recipient' },
  configSchema,
  outputSchema: Type.Object({ appended: Type.Boolean() }),
  execute: async (config, ctx) => {
    assertConfig(configSchema, config)
    if (ctx.dryRun) return { appended: false }
    const path = config.filePath.split('/').map(encodePathPart).join('/')
    const url = `${ORIGIN}${path}:/workbook/tables/${encodePathPart(config.table)}/rows/add`
    await postRowRenewing(ctx.connections, config.connection, 'microsoft', url, config.values.map(excelCell))
    return { appended: true }
  },
})
