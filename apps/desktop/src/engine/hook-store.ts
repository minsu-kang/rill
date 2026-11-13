import { HOOK_LOG_DEFAULT_LIMIT, type Hook, type HookInput, type HookLogEntry } from '@rill/protocol'
import { useSyncExternalStore } from 'react'
import { errorCodeOf } from './agents'
import type { EngineClient } from './client'

export interface HookLogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: readonly HookLogEntry[]
}

export interface HooksState {
  status: 'loading' | 'ready' | 'error'
  loaded: boolean
  hooks: readonly Hook[]
  log: HookLogState
  error?: unknown
}

export interface HookStore {
  getState(): HooksState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  refreshLog(): Promise<void>
  save(input: HookInput & { id?: string }): Promise<Hook>
  remove(id: string): Promise<boolean>
}

const INITIAL: HooksState = { status: 'loading', loaded: false, hooks: [], log: { status: 'idle', entries: [] } }

function createHookStore(client: EngineClient): HookStore {
  let state: HooksState = INITIAL
  let started = false
  let generation = 0
  let logGeneration = 0
  let tail: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()

  function set(next: HooksState): void {
    state = next
    for (const listener of [...listeners]) listener()
  }

  function load(): Promise<void> {
    generation += 1
    const mine = generation
    return client.request('listHooks', {}).then(
      (result) => {
        if (mine === generation) set({ ...state, status: 'ready', loaded: true, hooks: result.hooks })
      },
      (error: unknown) => {
        if (mine === generation) set({ ...state, status: 'error', error })
      },
    )
  }

  function applied(hooks: readonly Hook[]): void {
    generation += 1
    if (state.status === 'ready') {
      set({ ...state, hooks })
      return
    }
    set({ ...state, hooks })
    void load()
  }

  function start(): void {
    if (started) return
    started = true
    client.onEvent((event) => {
      if (event.type === 'workflow.deleted') void load()
    })
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job).catch((error: unknown) => {
      if (errorCodeOf(error) === 'HOOK_NOT_FOUND') void load()
      throw error
    })
    tail = run.catch(() => undefined)
    return run
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      if (!started) {
        start()
        void load()
      } else if (state.status === 'error') {
        set({ ...state, status: 'loading' })
        void load()
      }
      return () => {
        listeners.delete(listener)
      }
    },
    refresh() {
      start()
      if (state.status === 'error') set({ ...state, status: 'loading' })
      return load()
    },
    refreshLog() {
      logGeneration += 1
      const mine = logGeneration
      set({ ...state, log: { ...state.log, status: 'loading' } })
      return client.request('listHookLog', { limit: HOOK_LOG_DEFAULT_LIMIT }).then(
        (result) => {
          if (mine === logGeneration) set({ ...state, log: { status: 'ready', entries: result.entries } })
        },
        () => {
          if (mine === logGeneration) set({ ...state, log: { ...state.log, status: 'error' } })
        },
      )
    },
    save: (input) =>
      enqueue(async () => {
        const { hook } = await client.request('saveHook', input)
        const known = state.hooks.some((entry) => entry.id === hook.id)
        applied(known ? state.hooks.map((entry) => (entry.id === hook.id ? hook : entry)) : [...state.hooks, hook])
        return hook
      }),
    remove: (id) =>
      enqueue(async () => {
        const { deleted } = await client.request('deleteHook', { id })
        applied(state.hooks.filter((entry) => entry.id !== id))
        return deleted
      }),
  }
}

const STORES = new WeakMap<object, HookStore>()

export function hookStoreFor(client: EngineClient): HookStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createHookStore(client)
  STORES.set(client, created)
  return created
}

export function useHookStore(client: EngineClient): { state: HooksState; store: HookStore } {
  const store = hookStoreFor(client)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { state, store }
}
