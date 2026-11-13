import { baseNodeType, type ConnectionResolver } from '@rill/nodes-core'
import { HOOK_MAX_ITEMS, checkHookInput, hookProblemLine, type HookInput, type HookProblem } from '@rill/protocol'

export const NOTIFY_NODE_TYPE = 'notify.slack'
export const SLACK_CONNECTION_KIND = 'slack'

export class HookInvalidError extends Error {
  readonly problemList: HookProblem[]
  readonly problems: string[]

  constructor(problems: HookProblem[]) {
    super('the hook is not valid')
    this.name = 'HookInvalidError'
    this.problemList = problems
    this.problems = problems.map(hookProblemLine)
  }
}

export class HookFullError extends Error {
  constructor() {
    super(`at most ${HOOK_MAX_ITEMS} hooks can be saved; delete one first`)
    this.name = 'HookFullError'
  }
}

export class HookNotFoundError extends Error {
  constructor() {
    super('the hook was not found')
    this.name = 'HookNotFoundError'
  }
}

export interface HookCheckDeps {
  hasWorkflow(id: string): boolean
  connections: ConnectionResolver
  forbiddenNodes: readonly string[]
}

export function notifyForbidden(forbiddenNodes: readonly string[]): boolean {
  return forbiddenNodes.some((type) => baseNodeType(type).toLowerCase() === NOTIFY_NODE_TYPE)
}

export function checkHook(input: HookInput, deps: HookCheckDeps): HookInput {
  const checked = checkHookInput(input, {
    workflowExists: (id) => deps.hasWorkflow(id),
    connectionKind: (name) => (deps.connections.get(name) === undefined ? 'missing' : deps.connections.kindOf?.(name) === SLACK_CONNECTION_KIND ? 'slack' : 'other'),
    notifyForbidden: notifyForbidden(deps.forbiddenNodes),
  })
  if (!checked.ok) throw new HookInvalidError(checked.problems)
  return checked.input
}
