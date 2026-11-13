import { plainText } from './clamp'

export const MAX_TABS = 8
export const TITLE_MAX = 28

export interface ChatTab {
  id: string
  firstMessage: string | undefined
  working: boolean
  unread: boolean
  hasContent: boolean
  answers: number
}

export interface TabsState {
  tabs: ChatTab[]
  activeId: string
  serial: number
}

export type TabsAction =
  | { type: 'open' }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'report'; id: string; firstMessage: string | undefined; working: boolean; hasContent: boolean; answers: number }

function freshTab(serial: number): ChatTab {
  return { id: `chat-${serial}`, firstMessage: undefined, working: false, unread: false, hasContent: false, answers: 0 }
}

export function initialTabs(): TabsState {
  const tab = freshTab(1)
  return { tabs: [tab], activeId: tab.id, serial: 1 }
}

export function canOpenTab(state: TabsState): boolean {
  return state.tabs.length < MAX_TABS
}

export function tabTitle(firstMessage: string | undefined): string | undefined {
  const text = (firstMessage ?? '').replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : plainText(text, TITLE_MAX)
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      if (!canOpenTab(state)) return state
      const tab = freshTab(state.serial + 1)
      return { tabs: [...state.tabs, tab], activeId: tab.id, serial: state.serial + 1 }
    }
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      if (index < 0) return state
      const rest = state.tabs.filter((tab) => tab.id !== action.id)
      if (rest.length === 0) {
        const tab = freshTab(state.serial + 1)
        return { tabs: [tab], activeId: tab.id, serial: state.serial + 1 }
      }
      if (state.activeId !== action.id) return { ...state, tabs: rest }
      return { ...state, tabs: rest, activeId: rest[Math.min(index, rest.length - 1)]!.id }
    }
    case 'activate': {
      const tab = state.tabs.find((item) => item.id === action.id)
      if (tab === undefined) return state
      if (state.activeId === action.id && !tab.unread) return state
      return { ...state, activeId: action.id, tabs: state.tabs.map((item) => (item.id === action.id ? { ...item, unread: false } : item)) }
    }
    case 'report': {
      const tab = state.tabs.find((item) => item.id === action.id)
      if (tab === undefined) return state
      const unread = tab.unread || (action.answers > tab.answers && action.id !== state.activeId)
      if (tab.firstMessage === action.firstMessage && tab.working === action.working && tab.hasContent === action.hasContent && tab.answers === action.answers && tab.unread === unread) return state
      return {
        ...state,
        tabs: state.tabs.map((item) => (item.id === action.id ? { ...item, firstMessage: action.firstMessage, working: action.working, hasContent: action.hasContent, answers: action.answers, unread } : item)),
      }
    }
  }
}
