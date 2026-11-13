import { useSyncExternalStore } from 'react'
import type { EngineClient } from '../../../engine/client'
import type { HookDraft } from './hooks'

export interface HookEditorState {
  id: string | undefined
  base: HookDraft
  draft: HookDraft
}

export interface HooksViewStore {
  getState(): HookEditorState | undefined
  subscribe(listener: () => void): () => void
  update(change: HookEditorState | undefined | ((current: HookEditorState | undefined) => HookEditorState | undefined)): void
}

function createHooksViewStore(): HooksViewStore {
  let state: HookEditorState | undefined
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(change) {
      const next = typeof change === 'function' ? change(state) : change
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const STORES = new WeakMap<object, HooksViewStore>()

export function hooksViewFor(client: EngineClient): HooksViewStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createHooksViewStore()
  STORES.set(client, created)
  return created
}

export function useHookEditor(client: EngineClient): { editor: HookEditorState | undefined; setEditor: HooksViewStore['update'] } {
  const store = hooksViewFor(client)
  const editor = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { editor, setEditor: store.update }
}
