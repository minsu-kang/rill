import type { NodeInfo } from '@rill/protocol'

export type BadgeKind = 'externalTransfer' | 'writesFile' | 'network'

export function badgesOf(type: string, info: NodeInfo | undefined): BadgeKind[] {
  const badges: BadgeKind[] = []
  if (type.startsWith('llm.')) badges.push('externalTransfer')
  if (info?.sideEffect === 'idempotent') badges.push('writesFile')
  if (info?.sideEffect === 'external') badges.push('network')
  return badges
}
