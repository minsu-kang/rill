import type { Skill, SkillField, SkillFields } from '@rill/protocol'
import { useSyncExternalStore } from 'react'
import type { EngineClient } from '../../../engine/client'
import type { SkillFileProblem } from '../skill-file'
import { emptySkillDraft, sameSkillDraft, skillDraftOf, type SkillDraft } from './skill-draft'

export interface SkillReviewState {
  fileName: string
  base: SkillFields | undefined
  fileProblems: SkillFileProblem[]
  name: string
  description: string
}

export interface SkillViewState {
  selectedId: string | undefined
  creating: boolean
  edits: SkillDraft | undefined
  review: SkillReviewState | undefined
}

export type SkillViewAction =
  | { type: 'select'; id: string }
  | { type: 'create' }
  | { type: 'deselect' }
  | { type: 'edit'; field: SkillField; value: string; base: SkillDraft; id: string | undefined }
  | { type: 'revert' }
  | { type: 'saved'; id: string }
  | { type: 'review'; fileName: string; parsed: { fields: SkillFields | undefined; problems: SkillFileProblem[] } }
  | { type: 'reviewEdit'; field: 'name' | 'description'; value: string }
  | { type: 'reviewClose' }

export const INITIAL_SKILL_VIEW: SkillViewState = { selectedId: undefined, creating: false, edits: undefined, review: undefined }

export function skillViewReducer(state: SkillViewState, action: SkillViewAction): SkillViewState {
  switch (action.type) {
    case 'select':
      return { selectedId: action.id, creating: false, edits: undefined, review: undefined }
    case 'create':
      return { selectedId: undefined, creating: true, edits: undefined, review: undefined }
    case 'deselect':
      return INITIAL_SKILL_VIEW
    case 'edit': {
      const own = state.selectedId === action.id ? state.edits : undefined
      const next = { ...(own ?? action.base), [action.field]: action.value }
      return { ...state, selectedId: action.id, edits: sameSkillDraft(next, action.base) ? undefined : next }
    }
    case 'revert':
      return { ...state, edits: undefined }
    case 'saved':
      return { selectedId: action.id, creating: false, edits: undefined, review: undefined }
    case 'review':
      return {
        ...state,
        review: {
          fileName: action.fileName,
          base: action.parsed.fields,
          fileProblems: action.parsed.problems.filter((problem) => problem.kind === 'file'),
          name: action.parsed.fields?.name ?? '',
          description: action.parsed.fields?.description ?? '',
        },
      }
    case 'reviewEdit':
      return state.review === undefined ? state : { ...state, review: { ...state.review, [action.field]: action.value } }
    case 'reviewClose':
      return { ...state, review: undefined }
  }
}

export interface SkillSelection {
  skill: Skill | undefined
  creating: boolean
  baseline: SkillDraft
  draft: SkillDraft
  dirty: boolean
}

export function skillSelectionOf(state: SkillViewState, skills: readonly Skill[]): SkillSelection {
  if (state.creating || (skills.length === 0 && state.review === undefined)) {
    const baseline = emptySkillDraft()
    const draft = (state.selectedId === undefined ? state.edits : undefined) ?? baseline
    return { skill: undefined, creating: true, baseline, draft, dirty: !sameSkillDraft(draft, baseline) }
  }
  const skill = skills.find((entry) => entry.id === state.selectedId) ?? skills[0]
  const baseline = skill === undefined ? emptySkillDraft() : skillDraftOf(skill)
  const draft = (state.selectedId === skill?.id ? state.edits : undefined) ?? baseline
  return { skill, creating: false, baseline, draft, dirty: !sameSkillDraft(draft, baseline) }
}

export interface SkillViewStore {
  getState(): SkillViewState
  subscribe(listener: () => void): () => void
  dispatch(action: SkillViewAction): void
}

export function createSkillViewStore(): SkillViewStore {
  let state = INITIAL_SKILL_VIEW
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
      const next = skillViewReducer(state, action)
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const STORES = new WeakMap<object, SkillViewStore>()

export function skillViewStoreFor(client: EngineClient): SkillViewStore {
  const known = STORES.get(client)
  if (known !== undefined) return known
  const created = createSkillViewStore()
  STORES.set(client, created)
  return created
}

export function useSkillsView(client: EngineClient): { state: SkillViewState; store: SkillViewStore } {
  const store = skillViewStoreFor(client)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  return { state, store }
}
