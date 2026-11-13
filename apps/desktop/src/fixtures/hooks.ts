import { HOOK_MAX_ITEMS, type Hook, type HookAction, type HookEvent, type HookLogEntry, type HookScope } from '@rill/protocol'
import type { ConnectionSummary } from '../shared/host-api'
import { FIXTURE_NOW, ids } from './runs'

const MINUTE = 60_000

export const hookConnections: ConnectionSummary[] = [
  { name: 'team-slack', kind: 'slack', slack: { mode: 'bot', confirmed: true, account: 'Rill bot', channel: '#alerts' } },
  { name: 'ops-webhook', kind: 'slack' },
  { name: 'no-default-channel', kind: 'slack', slack: { mode: 'bot', confirmed: true } },
  { name: 'api-main', kind: 'http', authType: 'bearer' },
]

export function hookOf(id: string, event: HookEvent, scope: HookScope, action: HookAction, overrides: Partial<Pick<Hook, 'enabled' | 'createdAt' | 'updatedAt'>> = {}): Hook {
  const created = FIXTURE_NOW - 3 * 24 * 60 * MINUTE
  return { id, event, scope, action, enabled: true, createdAt: created, updatedAt: created, ...overrides }
}

const all: HookScope = { type: 'all' }
const only = (workflowId: string): HookScope => ({ type: 'workflow', workflowId })

const some: Hook[] = [
  hookOf('hook-failed-all', 'run.failed', all, { type: 'notify', connection: 'team-slack', channel: '#alerts' }),
  hookOf('hook-failed-receipt', 'run.failed', only(ids.workflows.receipt), { type: 'deactivateAfterFailures', count: 3 }),
  hookOf('hook-ok-webhook', 'run.succeeded', only(ids.workflows.webhook), { type: 'notify', connection: 'ops-webhook' }),
  hookOf('hook-deployed', 'plan.deployed', all, { type: 'record' }),
  hookOf('hook-failed-branching', 'run.failed', only(ids.workflows.branching), { type: 'notify', connection: 'team-slack' }, { enabled: false }),
]

const one: Hook[] = [some[0]!]

const full: Hook[] = Array.from({ length: HOOK_MAX_ITEMS }, (_, index) =>
  hookOf(`hook-${String(index + 1).padStart(2, '0')}`, 'run.failed', all, { type: 'notify', connection: 'team-slack', channel: `#alerts-${String(index + 1).padStart(2, '0')}` }),
)

const HOSTILE_CONNECTION = '<b>slack</b>‮prod​'

const hostile: Hook[] = [
  hookOf('hook-hostile', 'run.failed', only('wf-hostile'), { type: 'notify', connection: HOSTILE_CONNECTION, channel: '#alerts' }),
  hookOf('hook-long', 'run.succeeded', only('wf-long'), { type: 'notify', connection: 'team-slack' }),
]

const problems: Hook[] = [
  hookOf('hook-missing-connection', 'run.failed', all, { type: 'notify', connection: 'old-slack' }),
  hookOf('hook-webhook-channel', 'run.succeeded', all, { type: 'notify', connection: 'ops-webhook', channel: '#alerts' }),
  hookOf('hook-no-channel', 'plan.deployed', all, { type: 'notify', connection: 'no-default-channel' }),
]

export const hookFixtures = { some, one, full, hostile, problems, hostileConnection: HOSTILE_CONNECTION }

export function logRow(hookId: string, workflowId: string, event: HookEvent, outcome: HookLogEntry['outcome'], minutesAgo: number, code: HookLogEntry['code'] = null): HookLogEntry {
  return { id: 1, hookId, at: FIXTURE_NOW - minutesAgo * MINUTE, event, workflowId, outcome, code }
}

function ordered(rows: HookLogEntry[]): HookLogEntry[] {
  return [...rows].sort((a, b) => a.at - b.at).map((row, index) => ({ ...row, id: index + 1 }))
}

const mixed: HookLogEntry[] = ordered([
  logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', 'ok', 4),
  logRow('hook-failed-all', ids.workflows.branching, 'run.failed', 'skipped_cooldown', 3),
  logRow('hook-failed-receipt', ids.workflows.receipt, 'run.failed', 'ok', 4),
  logRow('hook-ok-webhook', ids.workflows.webhook, 'run.succeeded', 'failed', 12, 'connection'),
  logRow('hook-ok-webhook', ids.workflows.webhook, 'run.succeeded', 'failed', 40, 'timeout'),
  logRow('hook-ok-webhook', ids.workflows.webhook, 'run.succeeded', 'failed', 41, 'http_status'),
  logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', 'failed', 90, 'slack_error'),
  logRow('hook-failed-all', ids.workflows.receipt, 'run.failed', 'failed', 95, 'unknown'),
  logRow('hook-deployed', ids.workflows.webhook, 'plan.deployed', 'ok', 180),
  logRow('hook-failed-all', ids.workflows.branching, 'run.failed', 'rate_limited', 200),
  logRow('hook-failed-branching', ids.workflows.branching, 'run.failed', 'blocked_by_rule', 220),
  logRow('hook-failed-receipt', ids.workflows.receipt, 'run.failed', 'skipped_inactive', 300),
  logRow('hook-removed', ids.workflows.receipt, 'run.failed', 'ok', 600),
  logRow('hook-failed-all', 'wf-deleted', 'run.failed', 'ok', 900),
])

const many: HookLogEntry[] = ordered(
  Array.from({ length: 50 }, (_, index) => logRow('hook-deployed', ids.workflows.receipt, 'plan.deployed', index % 7 === 0 ? 'failed' : 'ok', index * 17 + 1, index % 7 === 0 ? 'timeout' : null)),
)

const hostileLog: HookLogEntry[] = ordered([
  logRow('hook-hostile', 'wf-hostile', 'run.failed', 'failed', 5, 'connection'),
  logRow('hook-long', 'wf-long', 'run.succeeded', 'ok', 8),
])

export const hookLogFixtures = { mixed, many, hostile: hostileLog }

export const HOSTILE_WORKFLOW_NAME = '<img src=x onerror=alert(1)> ‮gpj​</b> {{secret}}'
export const LONG_WORKFLOW_NAME = `Nightly reconciliation of every receipt, invoice and bank statement for all the regional offices ${'and their sub-ledgers '.repeat(4)}`
