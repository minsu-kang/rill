import { param } from '../placeholder'
import type { Recipe } from '../types'
import { slackConnectionParam } from './shared'

export const failureWebhookAlert: Recipe = {
  id: 'failure-webhook-alert',
  title: { ko: '실패 알림 전달', en: 'Failure webhook alert' },
  description: {
    ko: '웹훅 요청 본문의 status가 실패 값이면 슬랙으로 알려요.',
    en: 'Sends a Slack message when the status in a webhook request body is the failure value.',
  },
  tags: ['webhook', 'slack', 'monitoring'],
  params: [
    slackConnectionParam(),
    {
      id: 'failedStatus',
      kind: 'text',
      label: { ko: '실패로 볼 상태값', en: 'Failure status' },
      help: {
        ko: '요청 본문의 status 값이 이 값이면 알려요. status는 숫자가 아니라 문자로 보내야 해요. 예: "500"',
        en: 'Alert when the status field of the request body has this value. The sender must send status as text, for example "500", not as a number.',
      },
      required: false,
      default: 'failed',
    },
  ],
  workflow: {
    schemaVersion: 1,
    name: '실패 알림 전달',
    nodes: [
      { id: 't1', type: 'trigger.webhook@1', config: { path: '/failure-alert', method: 'POST' } },
      { id: 'n1', type: 'condition@1', config: { left: '{{t1.output.body.status}}', operator: 'eq', right: param('failedStatus') } },
      {
        id: 'n2',
        type: 'notify.slack@1',
        config: { connection: param('slackConnection'), text: '실패 알림이 들어왔어요. 상태를 확인해 주세요.' },
      },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2', when: 'true' },
    ],
  },
  sample: { slackConnection: 'slack-ops', failedStatus: 'error' },
}
