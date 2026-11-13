import {
  HOOK_LOG_DEFAULT_LIMIT,
  HOOK_LOG_MAX_LIMIT,
  HOOK_LOG_MAX_ROWS,
  HOOK_MAX_ITEMS,
  RillError,
  checkHookInput,
  hookKey,
  hookProblemLine,
  type Hook,
  type HookConnectionKind,
  type HookInput,
  type HookLogEntry,
  type MethodParams,
  type MethodResult,
} from '@rill/protocol'

export interface FakeHooksOptions {
  hooks?: readonly Hook[]
  log?: readonly HookLogEntry[]
  now?: () => number
}

export interface FakeHooksEnv {
  workflowIds: ReadonlySet<string>
  connections: ReadonlyMap<string, string>
  notifyForbidden: boolean
}

export interface FakeHooks {
  list(): MethodResult<'listHooks'>
  save(params: MethodParams<'saveHook'>, env: FakeHooksEnv): MethodResult<'saveHook'>
  remove(params: MethodParams<'deleteHook'>): MethodResult<'deleteHook'>
  log(params: MethodParams<'listHookLog'>): MethodResult<'listHookLog'>
  addLog(entry: Omit<HookLogEntry, 'id'>): HookLogEntry
  removeWorkflow(workflowId: string): void
  size(): number
}

const duplicate = (): RillError => new RillError('HOOK_INVALID', 'the hook is not valid', [hookProblemLine({ field: 'hook', rule: 'duplicate' })])

function inputOf(hook: Hook): HookInput {
  return { event: hook.event, scope: hook.scope, action: hook.action, enabled: hook.enabled }
}

export function createFakeHooks(options: FakeHooksOptions = {}): FakeHooks {
  const saved: Hook[] = structuredClone([...(options.hooks ?? [])])
  const rows: HookLogEntry[] = structuredClone([...(options.log ?? [])])
  const now = options.now ?? Date.now
  let serial = 0
  let logSerial = rows.reduce((top, row) => Math.max(top, row.id), 0)

  const kindOf = (env: FakeHooksEnv) => (name: string): HookConnectionKind => {
    const kind = env.connections.get(name)
    return kind === undefined ? 'missing' : kind === 'slack' ? 'slack' : 'other'
  }

  return {
    list: () => ({ hooks: structuredClone(saved) }),
    save(params, env) {
      const checked = checkHookInput(params, { workflowExists: (id) => env.workflowIds.has(id), connectionKind: kindOf(env), notifyForbidden: env.notifyForbidden })
      if (!checked.ok) throw new RillError('HOOK_INVALID', 'the hook is not valid', checked.problems.map(hookProblemLine))
      const key = hookKey(checked.input)
      const at = now()
      if (params.id !== undefined) {
        const found = saved.find((hook) => hook.id === params.id)
        if (found === undefined) throw new RillError('HOOK_NOT_FOUND', 'the hook was not found')
        if (saved.some((hook) => hook.id !== params.id && hookKey(inputOf(hook)) === key)) throw duplicate()
        Object.assign(found, checked.input, { updatedAt: at })
        return { hook: structuredClone(found) }
      }
      if (saved.some((hook) => hookKey(inputOf(hook)) === key)) throw duplicate()
      if (saved.length >= HOOK_MAX_ITEMS) throw new RillError('HOOK_FULL', `at most ${HOOK_MAX_ITEMS} hooks can be saved; delete one first`)
      serial += 1
      const hook: Hook = { id: `hook-new-${serial}`, ...checked.input, createdAt: at, updatedAt: at }
      saved.push(hook)
      return { hook: structuredClone(hook) }
    },
    remove({ id }) {
      const at = saved.findIndex((hook) => hook.id === id)
      if (at < 0) return { deleted: false }
      saved.splice(at, 1)
      return { deleted: true }
    },
    log({ limit, hookId }) {
      const requested = Number.isFinite(limit) ? Math.trunc(limit as number) : HOOK_LOG_DEFAULT_LIMIT
      const size = Math.min(Math.max(requested, 1), HOOK_LOG_MAX_LIMIT)
      const matching = hookId === undefined ? rows : rows.filter((row) => row.hookId === hookId)
      return { entries: structuredClone([...matching].reverse().slice(0, size)) }
    },
    addLog(entry) {
      logSerial += 1
      const row: HookLogEntry = { id: logSerial, ...entry }
      rows.push(row)
      if (rows.length > HOOK_LOG_MAX_ROWS) rows.splice(0, rows.length - HOOK_LOG_MAX_ROWS)
      return structuredClone(row)
    },
    removeWorkflow(workflowId) {
      for (let at = saved.length - 1; at >= 0; at--) {
        const { scope } = saved[at]!
        if (scope.type === 'workflow' && scope.workflowId === workflowId) saved.splice(at, 1)
      }
    },
    size: () => rows.length,
  }
}
