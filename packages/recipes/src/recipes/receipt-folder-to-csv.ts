import type { Recipe } from '../types'
import { RECEIPT_SAMPLE, csvFileParam, globParam, receiptNodes, watchFolderParam } from './shared'

export const receiptFolderToCsv: Recipe = {
  id: 'receipt-folder-to-csv',
  title: { ko: '영수증 폴더를 CSV로 정리', en: 'Receipt folder to CSV' },
  description: {
    ko: '폴더에 영수증이 들어오면 AI가 금액, 날짜, 가게 이름을 읽어 CSV 파일에 한 줄씩 쌓아요.',
    en: 'When a receipt lands in a folder, AI reads the amount, date and vendor and appends one row to a CSV file.',
  },
  tags: ['receipts', 'csv', 'ai', 'folder'],
  params: [watchFolderParam(), globParam(), csvFileParam()],
  workflow: {
    schemaVersion: 1,
    name: '영수증 폴더를 CSV로 정리',
    nodes: receiptNodes(),
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ],
  },
  sample: { ...RECEIPT_SAMPLE },
}
