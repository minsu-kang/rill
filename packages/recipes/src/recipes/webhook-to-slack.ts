import { param } from '../placeholder'
import type { Recipe } from '../types'
import { slackConnectionParam } from './shared'

export const webhookToSlack: Recipe = {
  id: 'webhook-to-slack',
  title: { ko: '웹훅을 슬랙으로 전달', en: 'Webhook to Slack' },
  description: {
    ko: '이 컴퓨터의 웹훅 주소로 요청이 들어오면 슬랙에 정해진 메시지를 보내요.',
    en: 'Sends a fixed Slack message whenever a request reaches a webhook path on this computer.',
  },
  tags: ['webhook', 'slack'],
  params: [slackConnectionParam()],
  workflow: {
    schemaVersion: 1,
    name: '웹훅을 슬랙으로 전달',
    nodes: [
      { id: 't1', type: 'trigger.webhook@1', config: { path: '/webhook-to-slack', method: 'POST' } },
      { id: 'n1', type: 'notify.slack@1', config: { connection: param('slackConnection'), text: '웹훅 요청이 도착했어요.' } },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  },
  sample: { slackConnection: 'slack-ops' },
}
