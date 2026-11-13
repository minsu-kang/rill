import { param } from '../placeholder'
import type { Recipe } from '../types'
import { RECEIPT_ROW, RECEIPT_SAMPLE, globParam, receiptReadNodes, watchFolderParam } from './shared'

export const receiptFolderToGoogleSheet: Recipe = {
  id: 'receipt-folder-to-google-sheet',
  title: { ko: '영수증 폴더를 구글 시트로 정리', en: 'Receipt folder to Google Sheet' },
  description: {
    ko: '폴더에 영수증이 들어오면 AI가 금액, 날짜, 가게 이름을 읽어 내 구글 계정의 스프레드시트에 한 줄씩 쌓아요.',
    en: 'When a receipt lands in a folder, AI reads the amount, date and vendor and appends one row to a Google Sheets spreadsheet in your Google account.',
  },
  tags: ['receipts', 'spreadsheet', 'google', 'ai', 'folder'],
  params: [
    watchFolderParam(),
    globParam(),
    {
      id: 'googleConnection',
      kind: 'connection',
      label: { ko: '구글 계정', en: 'Google account' },
      help: { ko: '설정의 연결 화면에서 연결한 구글 계정이에요.', en: 'The Google account that you connected in Settings, Connections.' },
      required: true,
      connectionKind: 'google',
    },
    {
      id: 'spreadsheetId',
      kind: 'spreadsheetId',
      label: { ko: '스프레드시트 ID', en: 'Spreadsheet id' },
      help: {
        ko: '스프레드시트 주소에서 /d/ 와 /edit 사이에 있는 긴 문자열이에요. 스프레드시트 제목이 아니에요.',
        en: 'The long id in the spreadsheet address, between /d/ and /edit. It is not the title of the spreadsheet.',
      },
      required: true,
    },
  ],
  workflow: {
    schemaVersion: 1,
    name: '영수증 폴더를 구글 시트로 정리',
    nodes: [
      ...receiptReadNodes(),
      { id: 'n2', type: 'google.sheets.append@1', config: { connection: param('googleConnection'), spreadsheetId: param('spreadsheetId'), values: [...RECEIPT_ROW] } },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ],
  },
  sample: { watchFolder: RECEIPT_SAMPLE.watchFolder, glob: RECEIPT_SAMPLE.glob, googleConnection: 'google', spreadsheetId: '1DemoSpreadsheetIdForRecipes0' },
}
