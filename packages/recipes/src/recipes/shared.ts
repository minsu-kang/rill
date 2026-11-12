import { param } from '../placeholder'
import type { RecipeParam } from '../types'

export function watchFolderParam(): RecipeParam {
  return {
    id: 'watchFolder',
    kind: 'folder',
    label: { ko: '감시할 폴더', en: 'Folder to watch' },
    help: { ko: '새 영수증 파일이 들어오는 폴더예요.', en: 'The folder where new receipt files arrive.' },
    required: true,
  }
}

export function globParam(): RecipeParam {
  return {
    id: 'glob',
    kind: 'glob',
    label: { ko: '파일 이름 패턴', en: 'File name pattern' },
    help: { ko: '처리할 파일의 이름 패턴이에요. 기본값은 PDF 파일이에요.', en: 'Which files to process. The default matches PDF files.' },
    required: false,
    default: '*.pdf',
  }
}

export function csvFileParam(): RecipeParam {
  return {
    id: 'csvFile',
    kind: 'file',
    label: { ko: 'CSV 파일', en: 'CSV file' },
    help: { ko: '영수증 한 장을 한 줄씩 쌓을 CSV 파일의 경로예요.', en: 'The CSV file that receives one row per receipt.' },
    required: true,
  }
}

export function slackConnectionParam(): RecipeParam {
  return {
    id: 'slackConnection',
    kind: 'connection',
    label: { ko: '슬랙 연결', en: 'Slack connection' },
    help: { ko: '알림을 받을 슬랙 연결의 이름이에요.', en: 'The name of the Slack connection that receives the message.' },
    required: true,
  }
}

export function scheduleParam(fallback: string, help: { ko: string; en: string }): RecipeParam {
  return { id: 'schedule', kind: 'cron', label: { ko: '실행 시각', en: 'Schedule' }, help, required: false, default: fallback }
}

export const RECEIPT_SAMPLE = {
  watchFolder: '/Users/demo/Receipts',
  glob: '*.png',
  csvFile: '/Users/demo/Receipts/ledger.csv',
} as const

export function receiptNodes() {
  return [
    { id: 't1', type: 'trigger.folderWatch@1', config: { folder: param('watchFolder'), glob: param('glob') } },
    {
      id: 'n1',
      type: 'llm.extract@1',
      config: {
        file: '{{t1.output.file}}',
        fields: [
          { name: 'amount', type: 'number', description: 'Total amount paid' },
          { name: 'date', type: 'date', description: 'Payment date' },
          { name: 'vendor', type: 'string', description: 'Store or vendor name' },
        ],
      },
      retry: { maxAttempts: 3 },
    },
    {
      id: 'n2',
      type: 'csv.append@1',
      config: { file: param('csvFile'), row: ['{{n1.output.date}}', '{{n1.output.vendor}}', '{{n1.output.amount}}'] },
    },
  ]
}
