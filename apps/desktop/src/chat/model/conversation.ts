import { flagKey, type AttachmentRef, type MethodParams, type PlanEffort, type PlanMeta, type PlanResultBody } from '@rill/protocol'
import type { MessageKey } from '../../i18n'
import { ATTACHMENT_LIMITS } from './attachments'
import { buildTurns, MAX_TURNS } from './turns'

export { MAX_TURNS }

export type UserEntry = { role: 'user'; text: string; attachments: AttachmentRef[]; answers?: Record<string, string> }
export type AssistantEntry = { role: 'assistant'; planId: string; result: PlanResultBody; meta: PlanMeta; deployed?: string }
export type ConversationEntry = UserEntry | AssistantEntry

export type ConversationState = {
  entries: ConversationEntry[]
  status: 'idle' | 'planning' | 'error'
  error?: MessageKey
  draft: string
  attachments: AttachmentRef[]
  effort: PlanEffort
  useMemory: boolean
  confirmed: Record<string, readonly string[]>
  unsent?: { draft: string; attachments: AttachmentRef[] }
}

export type ConversationAction =
  | { type: 'draft'; text: string }
  | { type: 'attach'; ref: AttachmentRef }
  | { type: 'detach'; id: string }
  | { type: 'effort'; effort: PlanEffort }
  | { type: 'useMemory'; value: boolean }
  | { type: 'submit'; text: string; answers?: Record<string, string> }
  | { type: 'planned'; planId: string; result: PlanResultBody; meta: PlanMeta }
  | { type: 'failed'; error: MessageKey }
  | { type: 'clearError' }
  | { type: 'toggleFlag'; planId: string; key: string }
  | { type: 'deployed'; planId: string; workflowId: string }
  | { type: 'workflowDeleted'; workflowId: string }

export function initialConversation(): ConversationState {
  return { entries: [], status: 'idle', draft: '', attachments: [], effort: 'medium', useMemory: true, confirmed: {} }
}

export function canSubmit(entries: readonly ConversationEntry[], kind: 'message' | 'answers'): boolean {
  return entries.length + (kind === 'answers' ? 1 : 0) <= MAX_TURNS
}

export function memoryInUse(useMemory: boolean, memoryCount: number | undefined): boolean {
  return useMemory && memoryCount !== undefined && memoryCount > 0
}

export function attachmentsInConversation(entries: readonly ConversationEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.role === 'user' ? entry.attachments.length : 0), 0)
}

function without(state: ConversationState, ...keys: Array<'error' | 'unsent'>): ConversationState {
  const copy = { ...state }
  for (const key of keys) delete copy[key]
  return copy
}

function submit(state: ConversationState, action: Extract<ConversationAction, { type: 'submit' }>): ConversationState {
  if (state.status === 'planning') return state
  const kind = action.answers === undefined ? 'message' : 'answers'
  if (!canSubmit(state.entries, kind)) return { ...state, status: 'error', error: 'chat.error.turnLimit' }
  if (action.answers !== undefined) {
    return { ...without(state, 'error', 'unsent'), status: 'planning', entries: [...state.entries, { role: 'user', text: '', attachments: [], answers: { ...action.answers } }] }
  }
  return {
    ...without(state, 'error'),
    status: 'planning',
    entries: [...state.entries, { role: 'user', text: action.text, attachments: [...state.attachments] }],
    draft: '',
    attachments: [],
    unsent: { draft: state.draft, attachments: state.attachments },
  }
}

function failed(state: ConversationState, error: MessageKey): ConversationState {
  if (state.status !== 'planning') return state
  const last = state.entries.at(-1)
  const entries = last?.role === 'user' ? state.entries.slice(0, -1) : state.entries
  const { unsent, ...rest } = state
  return {
    ...rest,
    entries,
    status: 'error',
    error,
    draft: unsent === undefined ? state.draft : unsent.draft,
    attachments: unsent === undefined ? state.attachments : unsent.attachments,
  }
}

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case 'draft':
      return action.text === state.draft ? state : { ...state, draft: action.text }
    case 'attach':
      if (state.attachments.some((item) => item.id === action.ref.id) || state.attachments.length >= ATTACHMENT_LIMITS.perMessage) return state
      return { ...state, attachments: [...state.attachments, action.ref] }
    case 'detach':
      return state.attachments.some((item) => item.id === action.id) ? { ...state, attachments: state.attachments.filter((item) => item.id !== action.id) } : state
    case 'effort':
      return action.effort === state.effort ? state : { ...state, effort: action.effort }
    case 'useMemory':
      return action.value === state.useMemory ? state : { ...state, useMemory: action.value }
    case 'submit':
      return submit(state, action)
    case 'planned': {
      if (state.status !== 'planning') return state
      return {
        ...without(state, 'error', 'unsent'),
        status: 'idle',
        entries: [...state.entries, { role: 'assistant', planId: action.planId, result: action.result, meta: action.meta }],
        confirmed: { ...state.confirmed, [action.planId]: [] },
      }
    }
    case 'failed':
      return failed(state, action.error)
    case 'clearError':
      return state.status === 'error' ? { ...without(state, 'error'), status: 'idle' } : state
    case 'toggleFlag': {
      const current = state.confirmed[action.planId] ?? []
      const next = current.includes(action.key) ? current.filter((key) => key !== action.key) : [...current, action.key]
      return { ...state, confirmed: { ...state.confirmed, [action.planId]: next } }
    }
    case 'workflowDeleted': {
      const gone = (entry: ConversationEntry): entry is AssistantEntry => entry.role === 'assistant' && entry.deployed === action.workflowId
      if (!state.entries.some(gone)) return state
      return {
        ...state,
        entries: state.entries.map((entry) => (gone(entry) ? { role: entry.role, planId: entry.planId, result: entry.result, meta: entry.meta } : entry)),
      }
    }
    case 'deployed': {
      const at = state.entries.findIndex((entry) => entry.role === 'assistant' && entry.planId === action.planId)
      if (at < 0) return state
      return { ...state, entries: state.entries.map((entry, index) => (index === at ? { ...entry, deployed: action.workflowId } : entry)) }
    }
  }
}

export function planParams(
  state: ConversationState,
  input: { planId: string; text: string; answers?: Record<string, string>; editContext?: { workflowId: string; nodeId?: string } },
): MethodParams<'plan'> {
  const entries: ConversationEntry[] =
    input.answers === undefined ? state.entries : [...state.entries, { role: 'user', text: '', attachments: [], answers: { ...input.answers } }]
  const params: MethodParams<'plan'> = {
    planId: input.planId,
    text: input.text,
    turns: buildTurns(entries),
    attachments: input.answers === undefined ? state.attachments.slice(0, ATTACHMENT_LIMITS.perMessage).map((item) => ({ ...item })) : [],
    effort: state.effort,
    useMemory: state.useMemory,
  }
  if (input.editContext !== undefined) {
    params.workflowId = input.editContext.workflowId
    if (input.editContext.nodeId !== undefined) params.selection = { nodeId: input.editContext.nodeId }
  }
  return params
}

export function canDeploy(entry: AssistantEntry, confirmed: readonly string[]): boolean {
  if (entry.result.kind !== 'workflow' || entry.deployed !== undefined) return false
  const required = new Set(entry.result.flags.map(flagKey))
  const given = new Set(confirmed)
  return required.size === given.size && [...required].every((key) => given.has(key))
}
