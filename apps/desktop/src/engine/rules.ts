import type { PlanEffort, Rule, RuleKind } from '@rill/protocol'
import { useSyncExternalStore } from 'react'
import { effortCapOf } from '../model/rules'
import type { EngineClient } from './client'
import { errorCodeOf } from './agents'

export interface RulesState {
  status: 'loading' | 'ready' | 'error'
  rules: readonly Rule[]
  error?: unknown
}

export interface RulesStore {
  getState(): RulesState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  save(kind: RuleKind, value: string): Promise<Rule>
  remove(id: string): Promise<boolean>
}

const INITIAL: RulesState = { status: 'loading', rules: [] }

function createRulesStore(client: EngineClient): RulesStore {
  let state: RulesState = INITIAL
  let started = false
  let generation = 0
  let tail: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()

  function set(next: RulesState): void {
    state = next
    for (const listener of [...listeners]) listener()
  }

  function load(): Promise<void> {
    generation += 1
    const mine = generation
    return client.request('listRules', {}).then(
      (result) => {
        if (mine === generation) set({ status: 'ready', rules: result.rules })
      },
      (error: unknown) => {
        if (mine === generation) set({ ...state, status: 'error', error })
      },
    )
  }

  function applied(rules: readonly Rule[]): void {
    generation += 1
    if (state.status === 'ready') {
      set({ status: 'ready', rules })
      return
    }
    set({ ...state, rules })
    void load()
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job).catch((error: unknown) => {
      if (errorCodeOf(error) === 'RULE_NOT_FOUND') void load()
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
        started = true
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
      started = true
      if (state.status === 'error') set({ ...state, status: 'loading' })
      return load()
    },
    save: (kind, value) =>
      enqueue(async () => {
        const { rule } = await client.request('saveRule', { kind, value })
        const known = state.rules.some((entry) => entry.id === rule.id)
        applied(known ? state.rules.map((entry) => (entry.id === rule.id ? rule : entry)) : [...state.rules, rule])
        return rule
      }),
    remove: (id) =>
      enqueue(async () => {
        const { deleted } = await client.request('deleteRule', { id })
        applied(state.rules.filter((entry) => entry.id !== id))
        return deleted
      }),
  }
}

const STORES = new WeakMap<object, RulesStore>()

export function rulesStoreFor(client: EngineClient): RulesStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createRulesStore(client)
  STORES.set(client, created)
  return created
}

export function useRules(client: EngineClient): { state: RulesState; store: RulesStore; cap: PlanEffort | undefined } {
  const store = rulesStoreFor(client)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { state, store, cap: effortCapOf(state.rules) }
}
