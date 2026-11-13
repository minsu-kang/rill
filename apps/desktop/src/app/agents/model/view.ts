import { AGENT_DEFAULT_ID, type Agent, type AgentField } from '@rill/protocol'
import { useSyncExternalStore } from 'react'
import type { EngineClient } from '../../../engine/client'
import { draftOf, emptyDraft, sameDraft, type AgentDraft } from './draft'

export interface ViewState {
  selectedId: string | undefined
  creating: boolean
  edits: AgentDraft | undefined
}

export type ViewAction =
  | { type: 'select'; id: string }
  | { type: 'create' }
  | { type: 'edit'; field: AgentField; value: string; base: AgentDraft }
  | { type: 'revert' }
  | { type: 'saved'; id: string }

export const INITIAL_VIEW: ViewState = { selectedId: undefined, creating: false, edits: undefined }

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'select':
      return { selectedId: action.id, creating: false, edits: undefined }
    case 'create':
      return { selectedId: undefined, creating: true, edits: undefined }
    case 'edit': {
      const next = { ...(state.edits ?? action.base), [action.field]: action.value }
      return { ...state, edits: sameDraft(next, action.base) ? undefined : next }
    }
    case 'revert':
      return { ...state, edits: undefined }
    case 'saved':
      return { selectedId: action.id, creating: false, edits: undefined }
  }
}

export interface Selection {
  agent: Agent | undefined
  creating: boolean
  baseline: AgentDraft
  draft: AgentDraft
  dirty: boolean
}

export function selectionOf(state: ViewState, agents: readonly Agent[], activeId: string): Selection {
  if (state.creating) {
    const baseline = emptyDraft()
    const draft = state.edits ?? baseline
    return { agent: undefined, creating: true, baseline, draft, dirty: !sameDraft(draft, baseline) }
  }
  const wanted = state.selectedId ?? activeId
  const agent = agents.find((entry) => entry.id === wanted) ?? agents.find((entry) => entry.id === AGENT_DEFAULT_ID)
  const baseline = agent === undefined ? emptyDraft() : draftOf(agent)
  const draft = state.edits ?? baseline
  return { agent, creating: false, baseline, draft, dirty: !sameDraft(draft, baseline) }
}

export interface ViewStore {
  getState(): ViewState
  subscribe(listener: () => void): () => void
  dispatch(action: ViewAction): void
}

export function createViewStore(): ViewStore {
  let state = INITIAL_VIEW
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch(action) {
      const next = viewReducer(state, action)
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const STORES = new WeakMap<object, ViewStore>()

export function viewStoreFor(client: EngineClient): ViewStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createViewStore()
  STORES.set(client, created)
  return created
}

export function useAgentsView(client: EngineClient): { state: ViewState; store: ViewStore } {
  const store = viewStoreFor(client)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { state, store }
}
