import type { Workflow, WorkflowEdge, WorkflowNode } from '@rill/dsl'

type NodeExtras = Partial<Pick<WorkflowNode, 'retry' | 'onError'>>

export function node(id: string, type: string, config: Record<string, unknown>, extras: NodeExtras = {}): WorkflowNode {
  return { id, type, config, ...extras }
}

export function edge(from: string, to: string, when?: string): WorkflowEdge {
  return when === undefined ? { from, to } : { from, to, when }
}

export function workflowOf(name: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { schemaVersion: 1, name, nodes, edges }
}

export const receiptWorkflow = workflowOf(
  '영수증 정리',
  [
    node('watch', 'trigger.folderWatch@1', { folder: '/Users/demo/Receipts', glob: '*.pdf' }),
    node(
      'extract',
      'llm.extract@1',
      {
        file: '{{watch.output.file}}',
        fields: [
          { name: 'amount', type: 'number', description: 'Total amount paid' },
          { name: 'date', type: 'date', description: 'Payment date' },
          { name: 'vendor', type: 'string', description: 'Store or vendor name' },
        ],
      },
      { retry: { maxAttempts: 3 } },
    ),
    node('append', 'csv.append@1', {
      file: '/Users/demo/ledger.csv',
      row: ['{{extract.output.date}}', '{{extract.output.vendor}}', '{{extract.output.amount}}'],
    }),
  ],
  [edge('watch', 'extract'), edge('extract', 'append')],
)

export const branchingWorkflow = workflowOf(
  '매일 서버 상태 확인',
  [
    node('schedule', 'trigger.cron@1', { expression: '0 9 * * 1-5', timezone: 'local' }),
    node(
      'check',
      'http.request@1',
      { url: 'https://api.example.com/health', method: 'GET' },
      { retry: { maxAttempts: 2, baseDelayMs: 500 }, onError: 'continue' },
    ),
    node('healthy', 'condition@1', { left: '{{check.output.status}}', operator: 'eq', right: 200 }),
    node('log', 'csv.append@1', { file: '/Users/demo/health.csv', row: ['{{check.output.status}}', 'ok'] }),
    node('alert', 'notify.slack@1', { connection: 'slack-ops', text: '서버 상태 확인에 실패했어요.' }),
  ],
  [
    edge('schedule', 'check'),
    edge('check', 'healthy'),
    edge('healthy', 'log', 'true'),
    edge('healthy', 'alert', 'false'),
  ],
)

export const webhookWorkflow = workflowOf(
  '웹훅을 슬랙으로 전달',
  [
    node('hook', 'trigger.webhook@1', { path: '/orders', method: 'POST' }),
    node('forward', 'http.request@1', { url: 'https://hooks.example.com/ingest', method: 'POST', body: '{{hook.output.body}}' }),
    node('notify', 'notify.slack@1', { connection: 'slack-ops', text: '웹훅 요청이 도착했어요.' }),
  ],
  [edge('hook', 'forward'), edge('hook', 'notify')],
)

export const workflows = { receipt: receiptWorkflow, branching: branchingWorkflow, webhook: webhookWorkflow }
