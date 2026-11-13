import type { Workflow } from '@rill/dsl'
import type {
  AttachmentRef,
  Flag,
  LlmCapabilitiesInfo,
  LlmModelInfo,
  LlmModelsResult,
  MemoryItem,
  PatchOp,
  PlanMeta,
  PlanResultBody,
  ProviderId,
} from '@rill/protocol'
import type { PlanOutcome } from '../engine/fake-plan'
import { FIXTURE_NOW } from './runs'
import { edge, node, workflowOf, workflows } from './workflows'

const USAGE = { inputTokens: 5200, outputTokens: 740, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

export function metaOf(overrides: Partial<PlanMeta> = {}): PlanMeta {
  return {
    rounds: [],
    usage: USAGE,
    costUsd: 0.0412,
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    effort: 'medium',
    effortDetail: { requested: 'medium', effective: 'medium', native: 'medium', collapsed: false, cappedByRule: false },
    fallbackUsed: false,
    ...overrides,
  }
}

export const metas = {
  plain: metaOf(),
  collapsed: metaOf({ effort: 'high', effortDetail: { requested: 'xhigh', effective: 'high', native: 'high', collapsed: true, cappedByRule: false } }),
  capped: metaOf({ effort: 'medium', effortDetail: { requested: 'xhigh', effective: 'medium', native: 'medium', collapsed: false, cappedByRule: true } }),
  nullCost: metaOf({ costUsd: null }),
  memory: metaOf({ memoryUsed: 3 }),
  memoryDropped: metaOf({ memoryUsed: 18, memoryDropped: 2 }),
  agent: metaOf({ agentUsed: { id: 'agent-terse', name: 'Terse reviewer' }, agentDropped: 0 }),
  agentDropped: metaOf({ agentDropped: 1 }),
  reasoningCapped: metaOf({ reasoningCapped: true }),
  costNote: metaOf({ costNote: 'The price of cached prompt tokens is counted at the full input rate, so the real cost can be lower.' }),
} satisfies Record<string, PlanMeta>

export function flagOf(nodeId: string, code: Flag['code'], pointer: string, message: string): Flag {
  return { nodeId, code, pointer, message }
}

export const flaggedWorkflow: Workflow = workflowOf(
  '청구서 합계 전송',
  [
    node('t1', 'trigger.folderWatch@1', { folder: '/Users/demo/Invoices', glob: '*.pdf' }),
    node('n1', 'llm.extract@1', {
      file: '{{t1.output.file}}',
      fields: [
        { name: 'amount', type: 'number' },
        { name: 'vendor', type: 'string' },
      ],
    }),
    node('c1', 'condition@1', { left: '{{n1.output.amount}}', operator: 'gt', right: 1000 }),
    node('n2', 'http.request@1', { url: 'https://collector.example.test/ingest', method: 'POST', body: '{{n1.output.amount}}' }, { retry: { maxAttempts: 2 } }),
    node('n3', 'csv.append@1', { file: '/Users/demo/Exports/totals.csv', row: ['{{n1.output.vendor}}', '{{n1.output.amount}}'] }),
    node('n4', 'notify.slack@1', { connection: 'slack-ops', text: '큰 금액의 청구서를 보냈어요.' }),
  ],
  [edge('t1', 'n1'), edge('n1', 'c1'), edge('c1', 'n2', 'true'), edge('c1', 'n3', 'false'), edge('n2', 'n4')],
)

const flaggedFlags: Flag[] = [
  flagOf('c1', 'untrusted_flow', '/nodes/2/config/left', '어느 가지로 갈지가 문서에서 읽은 금액으로 정해져요.'),
  flagOf('n2', 'new_egress_target', '/nodes/3/config/url', '요청에 없던 주소 https://collector.example.test/ingest 로 데이터를 보내요.'),
  flagOf('n3', 'attachment_origin', '/nodes/4/config/file', '이 경로는 붙인 파일에만 있어요.'),
]

export const manyFlagsWorkflow: Workflow = workflowOf(
  '청구서 합계를 여러 곳으로 전송',
  [
    node('t1', 'trigger.folderWatch@1', { folder: '/Users/demo/Invoices', glob: '*.pdf' }),
    node('n1', 'llm.extract@1', {
      file: '{{t1.output.file}}',
      fields: [
        { name: 'amount', type: 'number' },
        { name: 'region', type: 'string' },
        { name: 'limit', type: 'number' },
      ],
    }),
    node('c1', 'condition@1', { left: '{{n1.output.amount}}', operator: 'gt', right: '{{n1.output.limit}}' }),
    node('c2', 'condition@1', { left: '{{n1.output.region}}', operator: 'eq', right: 'KR' }),
    node('n2', 'http.request@1', { url: 'https://collector.example.test/ingest', method: 'POST', body: '{{n1.output.amount}}' }),
    node('n3', 'http.request@1', { url: 'https://backup.example.test/ingest', method: 'POST', body: '{{n1.output.amount}}' }),
    node('n4', 'csv.append@1', { file: '/Users/demo/Exports/totals.csv', row: ['{{n1.output.amount}}'] }),
    node('n5', 'notify.slack@1', { connection: 'slack-team', text: '전송을 마쳤어요.' }),
  ],
  [
    edge('t1', 'n1'),
    edge('n1', 'c1'),
    edge('c1', 'c2', 'true'),
    edge('c2', 'n2', 'true'),
    edge('c2', 'n3', 'false'),
    edge('n2', 'n4'),
    edge('n3', 'n4'),
    edge('n4', 'n5'),
  ],
)

const manyFlags: Flag[] = [
  flagOf('c1', 'untrusted_flow', '/nodes/2/config/left', '비교하는 값이 문서에서 읽어 온 값이에요.'),
  flagOf('c1', 'untrusted_flow', '/nodes/2/config/right', '기준 값도 문서에서 읽어 온 값이에요.'),
  flagOf('c2', 'untrusted_flow', '/nodes/3/config/left', '지역 값이 문서에서 읽어 온 값이에요.'),
  flagOf('n2', 'new_egress_target', '/nodes/4/config/url', '요청에 없던 주소로 데이터를 보내요.'),
  flagOf('n3', 'new_egress_target', '/nodes/5/config/url', '요청에 없던 백업 주소로 데이터를 보내요.'),
  flagOf('n4', 'new_egress_target', '/nodes/6/config/file', '요청에 없던 경로에 파일을 써요.'),
  flagOf('n2', 'attachment_origin', '/nodes/4/config/url', '이 주소는 붙인 파일에만 있어요.'),
  flagOf('n3', 'attachment_origin', '/nodes/5/config/url', '이 주소는 붙인 파일에만 있어요.'),
  flagOf('n5', 'attachment_origin', '/nodes/7/config/connection', '이 연결 이름은 붙인 파일에만 있어요.'),
]

const patchOps: PatchOp[] = [
  {
    op: 'set_config',
    nodeId: 'extract',
    config: {
      file: '{{watch.output.file}}',
      fields: [
        { name: 'amount', type: 'number', description: 'Total amount paid' },
        { name: 'date', type: 'date', description: 'Payment date' },
        { name: 'vendor', type: 'string', description: 'Store or vendor name' },
        { name: 'currency', type: 'string', description: 'Currency code' },
      ],
    },
    retry: { maxAttempts: 3 },
  },
  { op: 'add_node', node: node('notify', 'notify.slack@1', { connection: 'slack-ops', text: '새 영수증: {{extract.output.vendor}}' }) },
  { op: 'connect', edge: edge('extract', 'notify') },
  { op: 'disconnect', from: 'extract', to: 'append' },
  { op: 'remove_node', nodeId: 'append' },
]

export const patchedWorkflow: Workflow = workflowOf(
  workflows.receipt.name,
  [
    workflows.receipt.nodes[0]!,
    node(
      'extract',
      'llm.extract@1',
      {
        file: '{{watch.output.file}}',
        fields: [
          { name: 'amount', type: 'number', description: 'Total amount paid' },
          { name: 'date', type: 'date', description: 'Payment date' },
          { name: 'vendor', type: 'string', description: 'Store or vendor name' },
          { name: 'currency', type: 'string', description: 'Currency code' },
        ],
      },
      { retry: { maxAttempts: 3 } },
    ),
    node('notify', 'notify.slack@1', { connection: 'slack-ops', text: '새 영수증: {{extract.output.vendor}}' }),
  ],
  [edge('watch', 'extract'), edge('extract', 'notify')],
)

function workflowResult(workflow: Workflow, summary: string, flags: Flag[] = [], patch?: PatchOp[]): PlanResultBody {
  return {
    kind: 'workflow',
    workflow,
    summary,
    ...(patch === undefined ? {} : { patch }),
    flags,
    needsConfirmation: flags.length > 0,
  }
}

export const results = {
  workflow: workflowResult(workflows.receipt, '폴더 /Users/demo/Receipts 에 PDF가 들어오면 금액, 날짜, 가게 이름을 뽑아서 ledger.csv 에 한 줄씩 추가해요.'),
  flagged: workflowResult(
    flaggedWorkflow,
    '폴더 /Users/demo/Invoices 에 청구서 PDF가 들어오면 합계가 1,000을 넘을 때 외부 주소로 보내고 슬랙으로 알려요. 그렇지 않으면 totals.csv 에 기록해요.',
    flaggedFlags,
  ),
  manyFlags: workflowResult(manyFlagsWorkflow, '청구서의 합계와 기준을 비교해 두 외부 주소로 나눠 보내고, 파일에 기록한 뒤 슬랙으로 알려요.', manyFlags),
  patch: workflowResult(patchedWorkflow, '장부에 쓰는 대신 슬랙으로 알리도록 바꿨어요. 통화 항목도 함께 뽑아요.', [], patchOps),
  questions: {
    kind: 'questions',
    summary: '몇 가지만 알려 주세요.',
    questions: [
      { id: 'folder', text: '영수증 PDF가 들어오는 폴더가 어디인가요?', options: ['~/Receipts', '~/Downloads', '~/Desktop'], default: '~/Receipts' },
      { id: 'notify', text: '알림은 어디로 보낼까요?', options: ['slack-ops', 'slack-team', '알림 없음'], default: 'slack-ops' },
      { id: 'fields', text: '장부에 넣을 항목을 알려 주세요.', options: [], default: '날짜, 금액, 가게 이름' },
    ],
  },
  unsupported: {
    kind: 'unsupported',
    summary: '메일함을 직접 읽는 자동화는 만들 수 없어요.',
    reason: '이 앱에는 이메일을 읽어 오는 노드가 없어요. 지금은 폴더, 일정, 웹훅으로만 시작할 수 있어요.',
    nearest: '폴더에 저장한 메일 첨부 파일(PDF)이 들어오면 처리하는 워크플로우',
  },
} satisfies Record<string, PlanResultBody>

export function outcomeOf(result: PlanResultBody, meta: PlanMeta = metas.plain): PlanOutcome {
  return { result, meta }
}

const PROVIDER_LABELS: Record<ProviderId, { label: string; keyEnv: string }> = {
  anthropic: { label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI', keyEnv: 'OPENAI_API_KEY' },
  gemini: { label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY' },
  grok: { label: 'xAI Grok', keyEnv: 'XAI_API_KEY' },
  meta: { label: 'Meta', keyEnv: 'META_API_KEY' },
}

const ALL_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function capabilitiesOf(dataNote: string, overrides: Partial<LlmCapabilitiesInfo> = {}): LlmCapabilitiesInfo {
  return {
    structuredOutput: 'strict',
    documents: 'native-pdf',
    images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxRequestBytes: 32_000_000,
    cache: 'explicit',
    maxCacheBreakpoints: 4,
    effortLevels: [...ALL_LEVELS],
    effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    reasoningCappedByMaxTokens: false,
    streaming: 'optional',
    maxOutputTokens: 64_000,
    dataNote,
    ...overrides,
  }
}

function modelOf(provider: ProviderId, id: string, label: string, tier: LlmModelInfo['tier'], capabilities: LlmCapabilitiesInfo, contextTokens = 1_000_000): LlmModelInfo {
  return { provider, id, label, tier, contextTokens, capabilities }
}

const LONG_NOTE =
  'On the free tier Google may use your prompts and the files you attach to improve its products, and people may read some of them. Use a paid key for anything private. Files and memory notes are sent with every request, so remove a note you do not want to leave this computer before you plan. Data may be stored in a region outside your own country.'

const MODEL_TABLE: LlmModelInfo[] = [
  modelOf('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 'strong', capabilitiesOf('Your content is sent to the Anthropic API and handled under your Anthropic account terms.')),
  modelOf('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'mid', capabilitiesOf('Your content is sent to the Anthropic API and handled under your Anthropic account terms.', { effortLevels: ['low', 'medium', 'high', 'xhigh'] })),
  modelOf('anthropic', 'claude-haiku-5', 'Claude Haiku 5', 'cheap', capabilitiesOf('Your content is sent to the Anthropic API and handled under your Anthropic account terms.', { effortLevels: ['low', 'medium', 'high'] }), 200_000),
  modelOf('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', 'mid', capabilitiesOf('Your content is sent to OpenAI. Requests are sent with storage turned off.', { cache: 'automatic' })),
  modelOf('gemini', 'gemini-3-pro', 'Gemini 3 Pro', 'strong', capabilitiesOf(LONG_NOTE, { cache: 'automatic', effortLevels: ['low', 'medium', 'high'] })),
  modelOf('grok', 'grok-5', 'Grok 5', 'mid', capabilitiesOf('Your content is sent to xAI. Requests are sent with storage turned off. PDF files are not supported.', { documents: 'none', cache: 'automatic' })),
  modelOf('meta', 'muse-spark-1.0', 'Muse Spark 1.0', 'cheap', capabilitiesOf('Your content is sent to the Meta Model API.', { cache: 'none', effortLevels: ['low', 'medium'] }), 256_000),
]

function providersOf(configured: readonly ProviderId[]): LlmModelsResult['providers'] {
  return (Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => ({ id, label: PROVIDER_LABELS[id].label, keyEnv: PROVIDER_LABELS[id].keyEnv, configured: configured.includes(id) }))
}

export const models: LlmModelsResult = {
  models: MODEL_TABLE,
  providers: providersOf(['anthropic', 'openai', 'gemini', 'meta']),
  active: { provider: 'anthropic', model: 'claude-opus-5-5' },
}

export const modelsNothingConfigured: LlmModelsResult = { models: MODEL_TABLE, providers: providersOf([]), active: null }

export const modelsHaikuActive: LlmModelsResult = { ...models, active: { provider: 'anthropic', model: 'claude-haiku-5' } }

const NOTES = [
  '영수증 PDF는 ~/Receipts 폴더에 들어와요',
  '장부 파일은 ~/Receipts/ledger.csv 를 써요',
  '알림은 team-alerts 연결(Slack)로 보내요',
  '금액은 원화(KRW)이고 소수점은 쓰지 않아요',
  'Weekly reports go to ~/Reports/weekly.csv',
  '월말 정산 알림은 매월 말일 오전 9시에 받고 싶어요',
  'My accountant reads ~/Accounting/inbox every Monday',
  '개인 폴더 ~/Private 는 건드리지 마세요',
  'Use the slack-ops connection for failures',
  '사진 영수증은 ~/Receipts/photos 에 모아요',
  '데이터 스토어 백업은 ~/Backups 에 둬요',
  'Receipts older than a year go to ~/Archive',
  '세금 관련 문서는 ~/Taxes 에 있어요',
  '웹훅 알림은 슬랙 채널 #orders 로 보내요',
  '엑셀 대신 CSV만 써요',
  'Dates are written as YYYY-MM-DD',
  '출장 영수증은 ~/Travel 폴더에 있어요',
  '비용 보고서는 ~/Expenses/report.csv 에 이어 써요',
  'Time zone is Asia/Seoul',
  '메모는 한국어로 요약해 주세요',
]

function noteItems(count: number): MemoryItem[] {
  return NOTES.slice(0, count).map((text, index) => ({
    id: `mem-${String(index + 1).padStart(2, '0')}`,
    text,
    createdAt: FIXTURE_NOW - (count - index) * 3_600_000,
    updatedAt: FIXTURE_NOW - (count - index) * 3_600_000,
  }))
}

export const memoryFixtures = { empty: noteItems(0), three: noteItems(3), full: noteItems(20) }

function attachment(id: string, mediaType: AttachmentRef['mediaType'], name: string, bytes: number): AttachmentRef {
  return { id, mediaType, name, bytes }
}

export const attachmentRefs = {
  pdf: attachment('att-pdf-0001', 'application/pdf', 'Cafe Mori 영수증.pdf', 184_320),
  png: attachment('att-png-0002', 'image/png', 'receipt-photo.png', 2_100_000),
  jpeg: attachment('att-jpeg-0003', 'image/jpeg', 'scan.jpeg', 890_112),
  gif: attachment('att-gif-0004', 'image/gif', 'animation.gif', 420_000),
  webp: attachment('att-webp-0005', 'image/webp', 'menu.webp', 96_500),
  text: attachment('att-text-0006', 'text/plain', 'notes.txt', 1_240),
  csv: attachment('att-csv-00007', 'text/csv', 'ledger-sample.csv', 18_900),
  markdown: attachment('att-md-000008', 'text/markdown', 'README.md', 5_300),
  hostile: attachment('att-evil-0009', 'application/pdf', 'invoice‮gpj.exe\u0007 ​final.pdf', 52_000),
  long: attachment('att-long-0010', 'application/pdf', `${'a'.repeat(251)}.pdf`, 70_000),
}

export const allAttachmentRefs: AttachmentRef[] = Object.values(attachmentRefs)
