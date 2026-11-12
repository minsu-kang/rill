export type TriggerKind = 'manual' | 'webhook' | 'folderWatch' | 'cron' | 'other'

const KINDS: Readonly<Record<string, TriggerKind>> = {
  'trigger.manual@1': 'manual',
  'trigger.webhook@1': 'webhook',
  'trigger.folderWatch@1': 'folderWatch',
  'trigger.cron@1': 'cron',
}

export function triggerKind(triggerType: string): TriggerKind {
  return Object.hasOwn(KINDS, triggerType) ? KINDS[triggerType]! : 'other'
}

export function needsPayload(triggerType: string): boolean {
  const kind = triggerKind(triggerType)
  return kind === 'webhook' || kind === 'folderWatch' || kind === 'other'
}

export function payloadSample(triggerType: string, now: Date = new Date()): string {
  switch (triggerKind(triggerType)) {
    case 'webhook':
      return JSON.stringify({ method: 'POST', path: '/orders', query: {}, headers: {}, body: { orderId: 'A-1001', total: 12000 } }, null, 2)
    case 'folderWatch':
      return JSON.stringify({ file: '/path/to/sample.pdf', name: 'sample.pdf', extension: 'pdf', bytes: 1024, modifiedAt: now.toISOString() }, null, 2)
    default:
      return '{}'
  }
}
