import { AGENT_DEFAULT_ID, agentNameKey, type Agent, type AgentFields, type AgentKind } from '@rill/protocol'
import { useSyncExternalStore } from 'react'
import type { EngineClient } from './client'

export interface AgentsState {
  status: 'loading' | 'ready' | 'error'
  agents: readonly Agent[]
  activeId: string
  error?: unknown
}

export interface AgentsStore {
  getState(): AgentsState
  subscribe(listener: () => void): () => void
  watch(listener: () => void): () => void
  refresh(): Promise<void>
  select(id: string): Promise<void>
  save(input: AgentInput): Promise<Agent>
  remove(id: string): Promise<boolean>
}

export type AgentInput = AgentFields & { id?: string; kind?: AgentKind; skillIds?: string[] }

export function kindOf(agent: Pick<Agent, 'kind'>): AgentKind {
  return agent.kind ?? 'assistant'
}

export function skillIdsOf(agent: Pick<Agent, 'skillIds'>): readonly string[] {
  return agent.skillIds ?? []
}

export function assistantsOf(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => kindOf(agent) === 'assistant')
}

export function reviewersOf(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => kindOf(agent) === 'reviewer')
}

const INITIAL: AgentsState = { status: 'loading', agents: [], activeId: AGENT_DEFAULT_ID }

function byName(agents: readonly Agent[]): Agent[] {
  const builtin = agents.filter((agent) => agent.builtin)
  const saved = agents.filter((agent) => !agent.builtin).sort((a, b) => (agentNameKey(a.name) < agentNameKey(b.name) ? -1 : agentNameKey(a.name) > agentNameKey(b.name) ? 1 : 0))
  return [...builtin, ...saved]
}

export function errorCodeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

function createAgentsStore(client: EngineClient): AgentsStore {
  let state: AgentsState = INITIAL
  let started = false
  let generation = 0
  let tail: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()

  function set(next: AgentsState): void {
    state = next
    for (const listener of [...listeners]) listener()
  }

  function load(): Promise<void> {
    generation += 1
    const mine = generation
    return client.request('listAgents', {}).then(
      (result) => {
        if (mine === generation) set({ status: 'ready', agents: result.agents, activeId: result.activeId })
      },
      (error: unknown) => {
        if (mine === generation) set({ ...state, status: 'error', error })
      },
    )
  }

  function applied(next: Pick<AgentsState, 'agents' | 'activeId'>): void {
    generation += 1
    if (state.agents.length > 0) {
      set({ status: 'ready', ...next })
      return
    }
    set({ ...state, ...next })
    void load()
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job).catch((error: unknown) => {
      if (errorCodeOf(error) === 'AGENT_NOT_FOUND') void load()
      throw error
    })
    tail = run.catch(() => undefined)
    return run
  }

  function watch(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    getState: () => state,
    watch,
    subscribe(listener) {
      const stop = watch(listener)
      if (!started) {
        started = true
        void load()
      }
      return stop
    },
    refresh() {
      started = true
      if (state.status === 'error') set({ ...state, status: 'loading' })
      return load()
    },
    select: (id) =>
      enqueue(async () => {
        await client.request('setActiveAgent', { id })
        applied({ agents: state.agents, activeId: id })
      }),
    save: (input) =>
      enqueue(async () => {
        const { agent } = await client.request('saveAgent', input)
        applied({ agents: byName([...state.agents.filter((entry) => entry.id !== agent.id), agent]), activeId: state.activeId })
        return agent
      }),
    remove: (id) =>
      enqueue(async () => {
        const { deleted } = await client.request('deleteAgent', { id })
        applied({ agents: state.agents.filter((entry) => entry.id !== id), activeId: state.activeId === id ? AGENT_DEFAULT_ID : state.activeId })
        return deleted
      }),
  }
}

const STORES = new WeakMap<object, AgentsStore>()

export function agentsStoreFor(client: EngineClient): AgentsStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createAgentsStore(client)
  STORES.set(client, created)
  return created
}

export function useAgents(client: EngineClient): { state: AgentsState; store: AgentsStore } {
  const store = agentsStoreFor(client)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { state, store }
}

export function useAgentsState(client: EngineClient): AgentsState {
  const store = agentsStoreFor(client)
  return useSyncExternalStore(store.watch, store.getState, store.getState)
}

export function activeAgentOf(state: AgentsState): Agent | undefined {
  return state.agents.find((agent) => agent.id === state.activeId)
}

export function agentIdForRequest(state: AgentsState): string | undefined {
  return state.status === 'ready' && state.activeId !== AGENT_DEFAULT_ID && activeAgentOf(state) !== undefined ? state.activeId : undefined
}

export function sendsAgentText(state: AgentsState): boolean {
  if (agentIdForRequest(state) === undefined) return false
  const agent = activeAgentOf(state)
  return agent !== undefined && (agent.persona !== '' || agent.instructions !== '' || skillIdsOf(agent).length > 0)
}
