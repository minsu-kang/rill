import { param } from '../placeholder'
import type { Recipe } from '../types'
import { RECEIPT_SAMPLE, csvFileParam, globParam, receiptNodes, slackConnectionParam, watchFolderParam } from './shared'

export const receiptBigAmountAlert: Recipe = {
  id: 'receipt-big-amount-alert',
  title: { ko: '큰 금액 영수증 알림', en: 'Big receipt alert' },
  description: {
    ko: '영수증을 CSV에 쌓으면서, 기준 금액보다 큰 영수증은 슬랙으로 알려요.',
    en: 'Records receipts in a CSV file like the receipt ledger and sends a Slack message for a receipt above a threshold.',
  },
  tags: ['receipts', 'csv', 'ai', 'folder', 'slack'],
  params: [
    watchFolderParam(),
    globParam(),
    csvFileParam(),
    {
      id: 'threshold',
      kind: 'number',
      label: { ko: '기준 금액', en: 'Threshold amount' },
      help: { ko: '이 금액보다 큰 영수증이면 슬랙으로 알려요.', en: 'A receipt above this amount triggers a Slack message.' },
      required: true,
      min: 0,
      max: 1_000_000_000_000,
    },
    slackConnectionParam(),
  ],
  workflow: {
    schemaVersion: 1,
    name: '큰 금액 영수증 알림',
    nodes: [
      ...receiptNodes(),
      { id: 'n3', type: 'condition@1', config: { left: '{{n1.output.amount}}', operator: 'gt', right: param('threshold') } },
      {
        id: 'n4',
        type: 'notify.slack@1',
        config: { connection: param('slackConnection'), text: '한도를 넘는 영수증이 들어왔어요: {{n1.output.amount}}' },
      },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
      { from: 'n1', to: 'n3' },
      { from: 'n3', to: 'n4', when: 'true' },
    ],
  },
  sample: { ...RECEIPT_SAMPLE, threshold: 100000, slackConnection: 'slack-ops' },
}
