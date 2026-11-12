import type { RunSummary, StepDetail } from '@rill/protocol'
import { hostileValue } from './hostile'

export const FIXTURE_NOW = Date.UTC(2026, 10, 13, 9, 30, 0)

const MINUTE = 60_000
const ago = (minutes: number): number => FIXTURE_NOW - minutes * MINUTE

export const ids = {
  workflows: { receipt: 'wf-receipt', branching: 'wf-branching', webhook: 'wf-webhook' },
  runs: {
    receiptQueued: 'run-receipt-queued',
    receiptHostile: 'run-receipt-hostile',
    receiptFailed: 'run-receipt-failed',
    receiptOk: 'run-receipt-ok',
    branchingRunning: 'run-branching-running',
    branchingSkipped: 'run-branching-skipped',
    branchingContinued: 'run-branching-continued',
    webhookAbandoned: 'run-webhook-abandoned',
    webhookCancelled: 'run-webhook-cancelled',
    webhookDry: 'run-webhook-dry',
  },
} as const

interface RunOptions {
  status: RunSummary['status']
  createdMinutesAgo: number
  durationMinutes?: number
  dryRun?: boolean
  error?: string
}

function run(id: string, workflowId: string, options: RunOptions): RunSummary {
  const createdAt = ago(options.createdMinutesAgo)
  const started = options.status !== 'queued' && options.status !== 'cancelled'
  const finished = options.status === 'succeeded' || options.status === 'failed' || options.status === 'cancelled'
  return {
    id,
    workflowId,
    status: options.status,
    dryRun: options.dryRun ?? false,
    error: options.error ?? null,
    createdAt,
    startedAt: started ? createdAt + 1_000 : null,
    finishedAt: finished ? createdAt + (options.durationMinutes ?? 1) * MINUTE : null,
  }
}

interface StepOptions {
  attempt?: number
  input?: unknown
  output?: unknown
  error?: string
  startMinutesAgo: number
  durationSeconds?: number
}

function step(nodeId: string, status: StepDetail['status'], options: StepOptions): StepDetail {
  const startedAt = ago(options.startMinutesAgo)
  return {
    nodeId,
    attempt: options.attempt ?? 1,
    status,
    input: options.input ?? null,
    output: options.output ?? null,
    error: options.error ?? null,
    startedAt,
    finishedAt: status === 'running' ? null : startedAt + (options.durationSeconds ?? 2) * 1_000,
  }
}

const RECEIPT_FIELDS = [
  { name: 'amount', type: 'number', description: 'Total amount paid' },
  { name: 'date', type: 'date', description: 'Payment date' },
  { name: 'vendor', type: 'string', description: 'Store or vendor name' },
]

const PROVIDER_ERROR =
  'provider error: 503 Service Unavailable. The model provider could not take the request right now, the response said the service is overloaded and asked to try again later. ' +
  'The request carried one PDF page and a schema of three fields. The node waited and tried again, but every attempt got the same answer from the provider, so the run stopped here. ' +
  'Nothing was written to the ledger file. Check the provider status page and run the workflow again when the service is back, or lower the number of receipts that arrive at the same time.'

const hostile = hostileValue()

function receiptSteps(minutes: number, vendor: string, amount: number): StepDetail[] {
  const file = '/Users/demo/Receipts/lunch.pdf'
  return [
    step('extract', 'succeeded', {
      startMinutesAgo: minutes,
      durationSeconds: 6,
      input: { file, fields: RECEIPT_FIELDS },
      output: { amount, date: '2026-11-12', vendor },
    }),
    step('append', 'succeeded', {
      startMinutesAgo: minutes - 0.2,
      input: { file: '/Users/demo/ledger.csv', row: ['2026-11-12', vendor, amount] },
      output: { file: '/Users/demo/ledger.csv', written: true },
    }),
  ]
}

const checkOk = (minutes: number): StepDetail =>
  step('check', 'succeeded', {
    startMinutesAgo: minutes,
    input: { url: 'https://api.example.com/health', method: 'GET' },
    output: { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } },
  })

const conditionInput = (left: unknown) => ({ left, operator: 'eq', right: 200 })

export const fixtureRuns: RunSummary[] = [
  run(ids.runs.receiptQueued, ids.workflows.receipt, { status: 'queued', createdMinutesAgo: 1 }),
  run(ids.runs.branchingRunning, ids.workflows.branching, { status: 'running', createdMinutesAgo: 2 }),
  run(ids.runs.receiptHostile, ids.workflows.receipt, { status: 'succeeded', createdMinutesAgo: 20 }),
  run(ids.runs.webhookAbandoned, ids.workflows.webhook, { status: 'running', createdMinutesAgo: 45 }),
  run(ids.runs.branchingSkipped, ids.workflows.branching, { status: 'succeeded', createdMinutesAgo: 90 }),
  run(ids.runs.webhookDry, ids.workflows.webhook, { status: 'succeeded', createdMinutesAgo: 150, dryRun: true }),
  run(ids.runs.receiptFailed, ids.workflows.receipt, {
    status: 'failed',
    createdMinutesAgo: 180,
    durationMinutes: 2,
    error: `node extract failed: ${PROVIDER_ERROR}`,
  }),
  run(ids.runs.webhookCancelled, ids.workflows.webhook, { status: 'cancelled', createdMinutesAgo: 400 }),
  run(ids.runs.branchingContinued, ids.workflows.branching, { status: 'succeeded', createdMinutesAgo: 1_400 }),
  run(ids.runs.receiptOk, ids.workflows.receipt, { status: 'succeeded', createdMinutesAgo: 1_500 }),
]

export const fixtureSteps: Record<string, StepDetail[]> = {
  [ids.runs.receiptOk]: receiptSteps(1_500, 'Cafe Mori', 12_800),
  [ids.runs.receiptFailed]: [
    step('extract', 'failed', {
      attempt: 1,
      startMinutesAgo: 180,
      durationSeconds: 4,
      input: { file: '/Users/demo/Receipts/dinner.pdf', fields: RECEIPT_FIELDS },
      error: 'provider error: 503 Service Unavailable',
    }),
    step('extract', 'failed', {
      attempt: 2,
      startMinutesAgo: 179,
      durationSeconds: 4,
      input: { file: '/Users/demo/Receipts/dinner.pdf', fields: RECEIPT_FIELDS },
      error: 'provider error: 503 Service Unavailable',
    }),
    step('extract', 'failed', {
      attempt: 3,
      startMinutesAgo: 178,
      durationSeconds: 4,
      input: { file: '/Users/demo/Receipts/dinner.pdf', fields: RECEIPT_FIELDS },
      error: PROVIDER_ERROR,
    }),
  ],
  [ids.runs.receiptHostile]: [
    step('extract', 'succeeded', { startMinutesAgo: 20, durationSeconds: 6, input: hostile, output: hostile }),
    step('append', 'succeeded', {
      startMinutesAgo: 19,
      input: { file: '/Users/demo/ledger.csv', row: ['=HYPERLINK("http://example.invalid","click")', '<b>bold</b>', 1] },
      output: { file: '/Users/demo/ledger.csv', written: true },
    }),
  ],
  [ids.runs.branchingRunning]: [
    checkOk(2),
    step('healthy', 'running', { startMinutesAgo: 1.9, input: conditionInput(200) }),
  ],
  [ids.runs.branchingSkipped]: [
    checkOk(90),
    step('healthy', 'succeeded', { startMinutesAgo: 89.9, input: conditionInput(200), output: { result: true, branch: 'true' } }),
    step('log', 'succeeded', {
      startMinutesAgo: 89.8,
      input: { file: '/Users/demo/health.csv', row: [200, 'ok'] },
      output: { file: '/Users/demo/health.csv', written: true },
    }),
    step('alert', 'skipped', { startMinutesAgo: 89.8, durationSeconds: 0 }),
  ],
  [ids.runs.branchingContinued]: [
    step('check', 'failed', {
      attempt: 1,
      startMinutesAgo: 1_400,
      durationSeconds: 15,
      input: { url: 'https://api.example.com/health', method: 'GET' },
      error: 'request timed out after 15000 ms',
    }),
    step('check', 'continued', {
      attempt: 2,
      startMinutesAgo: 1_399.5,
      durationSeconds: 15,
      input: { url: 'https://api.example.com/health', method: 'GET' },
      error: 'request timed out after 15000 ms',
    }),
    step('healthy', 'succeeded', { startMinutesAgo: 1_399, input: conditionInput(null), output: { result: false, branch: 'false' } }),
    step('log', 'skipped', { startMinutesAgo: 1_399, durationSeconds: 0 }),
    step('alert', 'succeeded', {
      startMinutesAgo: 1_398.9,
      input: { connection: 'slack-ops', text: '서버 상태 확인에 실패했어요.' },
      output: { sent: true, status: 200 },
    }),
  ],
  [ids.runs.webhookAbandoned]: [
    step('forward', 'abandoned', {
      startMinutesAgo: 45,
      durationSeconds: 30,
      input: { url: 'https://hooks.example.com/ingest', method: 'POST', body: { order: 1042 } },
    }),
  ],
  [ids.runs.webhookDry]: [
    step('forward', 'succeeded', {
      startMinutesAgo: 150,
      input: { url: 'https://hooks.example.com/ingest', method: 'POST', body: { order: 1041 } },
      output: { status: 0, headers: {}, body: null, dryRun: true },
    }),
    step('notify', 'succeeded', {
      startMinutesAgo: 150,
      input: { connection: 'slack-ops', text: '웹훅 요청이 도착했어요.' },
      output: { sent: false, status: 0 },
    }),
  ],
}
