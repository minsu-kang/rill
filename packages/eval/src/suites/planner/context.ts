import type { AttachmentRef, PlanConnection, PlanEffort, PlanRequest } from '@rill/planner'
import { HOME_DIR } from './assertions'
import type { CaseSpec } from './schema'

export const CONNECTION_KINDS: Readonly<Record<string, PlanConnection['kind']>> = {
  'slack-ops': 'slack',
  'slack-general': 'slack',
  'slack-alerts': 'slack',
  'crm-token': 'http',
  'billing-api': 'http',
}

export const SPREADSHEET_DRAFT_CONNECTION_KINDS: Readonly<Record<string, PlanConnection['kind']>> = {
  'google-main': 'google',
  'microsoft-main': 'microsoft',
}

export const DEFAULT_ATTACHMENTS_ROOT = `${HOME_DIR}/.rill/attachments`
const ATTACHMENTS_FOLDER = '.attachments'

export function connectionsOf(names: readonly string[]): PlanConnection[] {
  return names.map((name) => {
    const kind = CONNECTION_KINDS[name] ?? SPREADSHEET_DRAFT_CONNECTION_KINDS[name]
    if (kind === undefined) throw new Error(`no connection kind is known for ${name}`)
    return { name, kind }
  })
}

export function attachmentsRootOf(allowedFolders: readonly string[]): string {
  const first = allowedFolders[0]
  return first === undefined ? DEFAULT_ATTACHMENTS_ROOT : `${first}/${ATTACHMENTS_FOLDER}`
}

export function buildPlanRequest(spec: CaseSpec, attachments: readonly AttachmentRef[], effort: PlanEffort = spec.effort): PlanRequest {
  const { context } = spec
  return {
    text: spec.prompt,
    turns: [],
    attachments: [...attachments],
    effort,
    ...(context.selectedNodeId === undefined ? {} : { selection: { nodeId: context.selectedNodeId } }),
    context: {
      connections: connectionsOf(context.connections),
      allowedRoots: [...context.allowedFolders],
      ...(context.existingWorkflow === undefined ? {} : { existingWorkflow: structuredClone(context.existingWorkflow) }),
      attachmentsRoot: attachmentsRootOf(context.allowedFolders),
      ...(context.memory === undefined ? {} : { memory: [...context.memory] }),
    },
  }
}

let depth = 0
let saved: string | undefined

export async function withDemoHome<T>(work: () => Promise<T>): Promise<T> {
  if (depth === 0) {
    saved = process.env['HOME']
    process.env['HOME'] = HOME_DIR
  }
  depth += 1
  try {
    return await work()
  } finally {
    depth -= 1
    if (depth === 0) {
      if (saved === undefined) delete process.env['HOME']
      else process.env['HOME'] = saved
      saved = undefined
    }
  }
}
