import type { ExplainMeta, ExplainResult } from '@rill/protocol'
import { ids } from './runs'

type Action = ExplainResult['suggestedActions'][number]
type Signal = ExplainResult['signals'][number]

export const EXPLAIN_RUN_ID = ids.runs.receiptFailed

export function explainMeta(overrides: Partial<ExplainMeta> = {}): ExplainMeta {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    effort: { requested: 'medium', effective: 'medium', native: 'medium', collapsed: false },
    digestChars: 3_412,
    truncated: false,
    usage: { inputTokens: 1_840, outputTokens: 312, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    costUsd: 0.0043,
    repaired: false,
    ...overrides,
  }
}

interface Parts {
  explanation: string
  likelyCause: ExplainResult['likelyCause']
  suggestedActions?: Action[]
  signals?: Signal[]
  fixProposal?: ExplainResult['fixProposal']
  meta?: Partial<ExplainMeta>
}

function result(parts: Parts): ExplainResult {
  return {
    runId: EXPLAIN_RUN_ID,
    explanation: parts.explanation,
    likelyCause: parts.likelyCause,
    suggestedActions: parts.suggestedActions ?? [],
    ...(parts.fixProposal === undefined ? {} : { fixProposal: parts.fixProposal }),
    signals: parts.signals ?? [],
    meta: explainMeta(parts.meta),
  }
}

const SIGNALS: Signal['signal'][] = [
  'unknown_connection',
  'path_not_allowed',
  'invalid_config',
  'unresolved_reference',
  'http_status_4xx',
  'http_status_401_403',
  'http_status_404',
  'http_status_429',
  'http_status_5xx',
  'network_error',
  'timeout',
  'file_missing',
  'file_unreadable',
  'llm_unavailable',
  'llm_extract_failed',
  'condition_error',
  'slack_error',
  'csv_error',
  'unknown',
]

const LONG_EXPLANATION = Array.from({ length: 120 }, (_, index) => `단계 ${index + 1}에서 확인한 내용이에요.`)
  .join(' ')
  .slice(0, 1_499)
  .concat('.')

export const explainCases = {
  configuration: result({
    likelyCause: 'configuration',
    explanation: '영수증을 읽는 단계의 설정에 빠진 값이 있어서 실행이 멈췄어요. 파일 참조가 앞 단계의 출력과 이어지지 않았어요.',
    suggestedActions: ['edit_node'],
    signals: [{ nodeId: 'extract', signal: 'invalid_config' }],
    fixProposal: { nodeId: 'extract', requestText: 'extract 노드의 file 설정을 감시 폴더에서 들어온 파일로 다시 이어 주세요.' },
  }),
  inputData: result({
    likelyCause: 'input_data',
    explanation: '들어온 파일이 비어 있어서 내용을 읽을 수 없었어요. 같은 파일을 다시 받아 보세요.',
    suggestedActions: ['check_input_file', 'retry_run'],
    signals: [{ nodeId: 'extract', signal: 'file_unreadable' }],
  }),
  externalService: result({
    likelyCause: 'external_service',
    explanation: '서버가 5xx 오류를 돌려줬어요. 상대 서비스의 일시적인 문제로 보여요.',
    suggestedActions: ['wait_and_retry', 'retry_run'],
    signals: [{ nodeId: 'check', signal: 'http_status_5xx' }],
  }),
  credentials: result({
    likelyCause: 'credentials_or_connection',
    explanation: '슬랙 연결이 설정되어 있지 않아서 알림을 보내지 못했어요.',
    suggestedActions: ['open_connections', 'retry_run', 'deactivate_workflow'],
    signals: [
      { nodeId: 'alert', signal: 'unknown_connection' },
      { nodeId: 'alert', signal: 'slack_error' },
    ],
  }),
  permission: result({
    likelyCause: 'permission_or_path',
    explanation: '장부 파일이 허용된 폴더 밖에 있어서 쓸 수 없었어요.',
    suggestedActions: ['edit_node'],
    signals: [{ nodeId: 'append', signal: 'path_not_allowed' }],
    fixProposal: { nodeId: 'append', requestText: 'append 노드의 file 경로를 허용된 폴더 안으로 옮겨 주세요.' },
  }),
  rateLimit: result({
    likelyCause: 'rate_limit_or_timeout',
    explanation: '요청이 너무 많아서 상대 서비스가 429를 돌려줬어요. 조금 기다렸다가 다시 하면 돼요.',
    suggestedActions: ['wait_and_retry'],
    signals: [
      { nodeId: 'check', signal: 'http_status_429' },
      { nodeId: 'check', signal: 'timeout' },
    ],
  }),
  design: result({
    likelyCause: 'workflow_design',
    explanation: '조건 노드가 비교할 값을 찾지 못했어요. 앞 단계가 건너뛰어지면 이 참조는 항상 비어 있어요.',
    suggestedActions: ['edit_node', 'deactivate_workflow'],
    signals: [
      { nodeId: 'healthy', signal: 'unresolved_reference' },
      { nodeId: 'healthy', signal: 'condition_error' },
    ],
    fixProposal: { nodeId: 'healthy', requestText: 'healthy 조건이 check 단계가 실패해도 동작하도록 고쳐 주세요.' },
  }),
  unknown: result({
    likelyCause: 'unknown',
    explanation: '기록만으로는 원인을 정하기 어려웠어요. 단계의 입력과 출력을 직접 확인해 보세요.',
    suggestedActions: ['none'],
    signals: [{ nodeId: 'extract', signal: 'unknown' }],
  }),
  noActions: result({ likelyCause: 'unknown', explanation: '제안할 행동이 없어요.', suggestedActions: [] }),
  threeActions: result({
    likelyCause: 'credentials_or_connection',
    explanation: '연결을 고친 뒤 다시 실행하거나 그동안 워크플로우를 꺼 둘 수 있어요.',
    suggestedActions: ['open_connections', 'retry_run', 'deactivate_workflow'],
    signals: [{ nodeId: 'alert', signal: 'unknown_connection' }],
  }),
  hiddenText: result({
    likelyCause: 'configuration',
    explanation: '요청 주소가 <hidden> 으로 바뀌어 있어요. 원래 주소는 안전을 위해 지웠어요.',
    suggestedActions: ['edit_node'],
    signals: [{ nodeId: 'forward', signal: 'invalid_config' }],
    fixProposal: { nodeId: 'forward', requestText: 'forward 노드의 url을 <hidden> 대신 올바른 주소로 바꿔 주세요.' },
  }),
  truncated: result({
    likelyCause: 'input_data',
    explanation: '기록이 길어서 일부 단계는 빼고 읽었어요. 읽은 범위 안에서는 입력 파일이 비어 있었어요.',
    suggestedActions: ['check_input_file'],
    signals: [{ nodeId: 'extract', signal: 'file_missing' }],
    meta: { truncated: true, digestChars: 12_000 },
  }),
  repaired: result({
    likelyCause: 'external_service',
    explanation: '첫 응답을 쓸 수 없어서 한 번 더 물었어요. 서버 오류로 보여요.',
    suggestedActions: ['wait_and_retry'],
    signals: [{ nodeId: 'check', signal: 'http_status_5xx' }],
    meta: { repaired: true, usage: { inputTokens: 3_700, outputTokens: 540, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  }),
  costUnknown: result({
    likelyCause: 'external_service',
    explanation: '이 모델의 가격을 몰라서 비용을 계산하지 못했어요.',
    suggestedActions: ['wait_and_retry'],
    meta: { costUsd: null, model: 'local-model', provider: 'custom' },
  }),
  effortLowered: result({
    likelyCause: 'rate_limit_or_timeout',
    explanation: '선택한 모델이 요청한 단계를 지원하지 않아서 더 낮은 단계로 물었어요.',
    suggestedActions: ['wait_and_retry'],
    meta: { effort: { requested: 'high', effective: 'medium', native: 'medium', collapsed: true } },
  }),
  manySignals: result({
    likelyCause: 'unknown',
    explanation: '여러 단계에서 서로 다른 신호가 보였어요.',
    suggestedActions: ['none'],
    signals: SIGNALS.map((signal, index) => ({ nodeId: `step-${index + 1}`, signal })),
  }),
  longExplanation: result({ likelyCause: 'unknown', explanation: LONG_EXPLANATION, suggestedActions: ['none'] }),
  hostile: result({
    likelyCause: 'unknown',
    explanation: '<img src=x onerror="window.__pwned = 1"> <script>window.__pwned = 1</script> [링크](javascript:window.__pwned=1) **굵게** invoice ‮txt.exe ' + 'A'.repeat(1_200),
    suggestedActions: ['none'],
    signals: [{ nodeId: `<img src=x onerror=alert(1)>${'n'.repeat(200)}`, signal: 'unknown' }],
    fixProposal: { nodeId: 'extract', requestText: '<a href="javascript:alert(1)">클릭</a> ‮txt.exe ' + 'B'.repeat(300) },
  }),
} as const satisfies Record<string, ExplainResult>

export type ExplainCaseName = keyof typeof explainCases
