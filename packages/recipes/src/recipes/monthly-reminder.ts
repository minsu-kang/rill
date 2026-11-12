import { param } from '../placeholder'
import type { Recipe } from '../types'
import { scheduleParam, slackConnectionParam } from './shared'

export const monthlyReminder: Recipe = {
  id: 'monthly-reminder',
  title: { ko: '매월 알림', en: 'Monthly reminder' },
  description: {
    ko: '정해진 시각에 슬랙으로 알림 메시지를 보내요. 기본값은 매월 1일 오전 9시예요.',
    en: 'Sends a Slack reminder on a schedule. The default is the first day of each month at 9:00.',
  },
  tags: ['schedule', 'slack', 'reminder'],
  params: [
    scheduleParam('0 9 1 * *', {
      ko: '5칸 cron 식이에요. 기본값은 매월 1일 오전 9시예요.',
      en: 'A five-field cron expression. The default is the first day of each month at 9:00.',
    }),
    {
      id: 'message',
      kind: 'text',
      label: { ko: '알림 메시지', en: 'Message' },
      help: { ko: '슬랙으로 보낼 한 줄 메시지예요.', en: 'A one-line message to send to Slack.' },
      required: false,
      default: '이번 달 정산을 확인할 시간이에요.',
    },
    slackConnectionParam(),
  ],
  workflow: {
    schemaVersion: 1,
    name: '매월 알림',
    nodes: [
      { id: 't1', type: 'trigger.cron@1', config: { expression: param('schedule') } },
      { id: 'n1', type: 'notify.slack@1', config: { connection: param('slackConnection'), text: param('message') } },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  },
  sample: { schedule: '0 10 1 * *', message: 'Time to send the monthly report', slackConnection: 'slack-ops' },
}
