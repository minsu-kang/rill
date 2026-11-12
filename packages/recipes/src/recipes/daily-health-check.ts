import { param } from '../placeholder'
import type { Recipe } from '../types'
import { scheduleParam, slackConnectionParam } from './shared'

export const dailyHealthCheck: Recipe = {
  id: 'daily-health-check',
  title: { ko: '매일 서버 상태 확인', en: 'Daily health check' },
  description: {
    ko: '정해진 시각에 주소를 호출해서 응답이 없거나 상태 코드가 200이 아니면 슬랙으로 알려요.',
    en: 'Calls a URL on a schedule and sends a Slack message when it does not answer or the status is not 200.',
  },
  tags: ['monitoring', 'schedule', 'http', 'slack'],
  params: [
    scheduleParam('0 9 * * 1-5', {
      ko: '5칸 cron 식이에요. 기본값은 평일 오전 9시예요.',
      en: 'A five-field cron expression. The default is weekdays at 9:00.',
    }),
    {
      id: 'url',
      kind: 'url',
      label: { ko: '확인할 주소', en: 'URL to check' },
      help: {
        ko: 'http 또는 https로 시작하는 주소예요. 비밀번호나 토큰은 넣지 마세요.',
        en: 'An address that starts with http or https. Do not put a password or token in it.',
      },
      required: true,
    },
    slackConnectionParam(),
  ],
  workflow: {
    schemaVersion: 1,
    name: '매일 서버 상태 확인',
    nodes: [
      { id: 't1', type: 'trigger.cron@1', config: { expression: param('schedule') } },
      {
        id: 'n1',
        type: 'http.request@1',
        config: { url: param('url'), method: 'GET' },
        retry: { maxAttempts: 2 },
        onError: 'continue',
      },
      { id: 'n2', type: 'condition@1', config: { left: '{{n1.output.status}}', operator: 'neq', right: 200 } },
      {
        id: 'n3',
        type: 'notify.slack@1',
        config: { connection: param('slackConnection'), text: '서버 상태 확인에 실패했어요. 응답이 없거나 상태 코드가 200이 아니에요.' },
      },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3', when: 'true' },
    ],
  },
  sample: { schedule: '30 8 * * 1-5', url: 'https://example.test/health', slackConnection: 'slack-ops' },
}
