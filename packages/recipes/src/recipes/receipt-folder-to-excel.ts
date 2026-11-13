import { param } from '../placeholder'
import type { Recipe } from '../types'
import { RECEIPT_ROW, RECEIPT_SAMPLE, globParam, receiptReadNodes, watchFolderParam } from './shared'

export const receiptFolderToExcel: Recipe = {
  id: 'receipt-folder-to-excel',
  title: { ko: '영수증 폴더를 엑셀로 정리', en: 'Receipt folder to Excel' },
  description: {
    ko: '폴더에 영수증이 들어오면 AI가 금액, 날짜, 가게 이름을 읽어 내 원드라이브의 엑셀 통합 문서 표에 한 줄씩 쌓아요.',
    en: 'When a receipt lands in a folder, AI reads the amount, date and vendor and appends one row to a table in an Excel workbook in your OneDrive.',
  },
  tags: ['receipts', 'spreadsheet', 'excel', 'ai', 'folder'],
  params: [
    watchFolderParam(),
    globParam(),
    {
      id: 'microsoftConnection',
      kind: 'connection',
      label: { ko: '마이크로소프트 계정', en: 'Microsoft account' },
      help: { ko: '설정의 연결 화면에서 연결한 마이크로소프트 계정이에요.', en: 'The Microsoft account that you connected in Settings, Connections.' },
      required: true,
      connectionKind: 'microsoft',
    },
    {
      id: 'workbookPath',
      kind: 'driveFile',
      label: { ko: '엑셀 파일 경로', en: 'Workbook path' },
      help: {
        ko: '원드라이브 안에 있는 .xlsx 파일의 경로예요. 맨 앞에 /를 붙이지 않아요. 예: Receipts/ledger.xlsx',
        en: 'The path of the .xlsx workbook in your OneDrive, without a leading slash. For example Receipts/ledger.xlsx',
      },
      required: true,
    },
    {
      id: 'tableName',
      kind: 'tableName',
      label: { ko: '표 이름', en: 'Table name' },
      help: {
        ko: '그 파일 안에 이미 만들어 둔 엑셀 표의 이름이에요. 표가 없으면 먼저 만들어 주세요.',
        en: 'The name of a table that already exists in that workbook. Create the table first if there is none.',
      },
      required: true,
    },
  ],
  workflow: {
    schemaVersion: 1,
    name: '영수증 폴더를 엑셀로 정리',
    nodes: [
      ...receiptReadNodes(),
      {
        id: 'n2',
        type: 'microsoft.excel.append@1',
        config: { connection: param('microsoftConnection'), filePath: param('workbookPath'), table: param('tableName'), values: [...RECEIPT_ROW] },
      },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ],
  },
  sample: {
    watchFolder: RECEIPT_SAMPLE.watchFolder,
    glob: RECEIPT_SAMPLE.glob,
    microsoftConnection: 'microsoft',
    workbookPath: 'Receipts/ledger.xlsx',
    tableName: 'Expenses',
  },
}
