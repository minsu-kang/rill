import { describe, expect, it } from 'vitest'
import { canOpenTab, initialTabs, MAX_TABS, tabsReducer, TITLE_MAX, tabTitle, type TabsAction, type TabsState } from '../src/chat/model/tabs'

const run = (state: TabsState, ...actions: TabsAction[]): TabsState => actions.reduce(tabsReducer, state)
const ids = (state: TabsState): string[] => state.tabs.map((tab) => tab.id)
const report = (id: string, patch: Partial<Extract<TabsAction, { type: 'report' }>> = {}): TabsAction => ({ type: 'report', id, firstMessage: undefined, working: false, hasContent: false, answers: 0, failed: false, ...patch })

function withTabs(count: number): TabsState {
  return run(initialTabs(), ...Array.from({ length: count - 1 }, () => ({ type: 'open' }) as const))
}

describe('tabs: start', () => {
  it('starts with one fresh, active tab', () => {
    const state = initialTabs()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeId).toBe(state.tabs[0]!.id)
    expect(state.tabs[0]).toMatchObject({ firstMessage: undefined, working: false, unread: false, hasContent: false, answers: 0 })
  })

  it('allows at most eight tabs', () => {
    expect(MAX_TABS).toBe(8)
  })
})

describe('tabs: open', () => {
  it('adds a tab at the end and activates it', () => {
    const first = initialTabs()
    const next = run(first, { type: 'open' })
    expect(next.tabs).toHaveLength(2)
    expect(next.tabs[0]).toBe(first.tabs[0])
    expect(next.activeId).toBe(next.tabs[1]!.id)
  })

  it('opens up to the limit with unique ids and then does nothing', () => {
    const full = withTabs(MAX_TABS)
    expect(full.tabs).toHaveLength(MAX_TABS)
    expect(new Set(ids(full)).size).toBe(MAX_TABS)
    expect(canOpenTab(full)).toBe(false)
    expect(run(full, { type: 'open' })).toBe(full)
    expect(canOpenTab(withTabs(MAX_TABS - 1))).toBe(true)
  })

  it('opens again after a close at the limit', () => {
    const full = withTabs(MAX_TABS)
    const smaller = run(full, { type: 'close', id: ids(full)[3]! })
    expect(canOpenTab(smaller)).toBe(true)
    expect(run(smaller, { type: 'open' }).tabs).toHaveLength(MAX_TABS)
  })

  it('never reuses the id of a tab that was closed', () => {
    let state = initialTabs()
    const seen = new Set(ids(state))
    for (let round = 0; round < 20; round += 1) {
      state = run(state, { type: 'open' })
      const opened = state.activeId
      expect(seen.has(opened)).toBe(false)
      seen.add(opened)
      state = run(state, { type: 'close', id: opened })
    }
  })
})

describe('tabs: close', () => {
  it('removes the tab and keeps the active one when another tab is closed', () => {
    const state = withTabs(3)
    const [a, b, c] = ids(state)
    const active = run(state, { type: 'activate', id: a! })
    const next = run(active, { type: 'close', id: b! })
    expect(ids(next)).toEqual([a, c])
    expect(next.activeId).toBe(a)
  })

  it('activates the next tab when the active one is closed, or the previous one at the end', () => {
    const state = withTabs(3)
    const [a, b, c] = ids(state)
    expect(run(state, { type: 'activate', id: b! }, { type: 'close', id: b! }).activeId).toBe(c)
    expect(run(state, { type: 'close', id: c! }).activeId).toBe(b)
    expect(run(state, { type: 'activate', id: a! }, { type: 'close', id: a! }).activeId).toBe(b)
  })

  it('leaves one fresh tab with a new id when the last tab is closed', () => {
    const only = initialTabs()
    const withState = run(only, report(only.activeId, { firstMessage: 'hello', hasContent: true, answers: 2 }))
    const next = run(withState, { type: 'close', id: only.activeId })
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0]!.id).not.toBe(only.activeId)
    expect(next.activeId).toBe(next.tabs[0]!.id)
    expect(next.tabs[0]).toMatchObject({ firstMessage: undefined, hasContent: false, working: false, unread: false, answers: 0 })
  })

  it('ignores an unknown id', () => {
    const state = withTabs(2)
    expect(run(state, { type: 'close', id: 'nope' })).toBe(state)
  })
})

describe('tabs: activate', () => {
  it('activates the tab and clears its unread mark, and only that one', () => {
    let state = withTabs(3)
    const [a, b, c] = ids(state)
    state = run(state, { type: 'activate', id: a! }, report(b!, { answers: 1 }), report(c!, { answers: 1 }))
    expect(state.tabs.map((tab) => tab.unread)).toEqual([false, true, true])
    state = run(state, { type: 'activate', id: b! })
    expect(state.activeId).toBe(b)
    expect(state.tabs.map((tab) => tab.unread)).toEqual([false, false, true])
  })

  it('ignores an unknown id and the tab that is already active without a mark', () => {
    const state = withTabs(2)
    expect(run(state, { type: 'activate', id: 'nope' })).toBe(state)
    expect(run(state, { type: 'activate', id: state.activeId })).toBe(state)
  })
})

describe('tabs: report', () => {
  it('stores the first message, the working flag, the content flag and the answer count', () => {
    const state = initialTabs()
    const next = run(state, report(state.activeId, { firstMessage: 'watch my folder', working: true, hasContent: true, answers: 1 }))
    expect(next.tabs[0]).toMatchObject({ firstMessage: 'watch my folder', working: true, hasContent: true, answers: 1, unread: false })
  })

  it('marks a background tab unread when it gets an answer, and never the active tab', () => {
    const state = withTabs(2)
    const [a, b] = ids(state)
    const second = run(state, report(a!, { answers: 1 }))
    expect(second.tabs[0]!.unread).toBe(true)
    const active = run(state, report(b!, { answers: 1 }))
    expect(active.tabs[1]!.unread).toBe(false)
  })

  it('keeps the mark until the tab is activated, whatever is reported meanwhile', () => {
    let state = withTabs(2)
    const [a] = ids(state)
    state = run(state, report(a!, { answers: 1 }), report(a!, { answers: 1, working: true }), report(a!, { answers: 1, working: false }))
    expect(state.tabs[0]!.unread).toBe(true)
  })

  it('does not mark unread when the answer count stays or drops', () => {
    let state = withTabs(2)
    const [a] = ids(state)
    state = run(state, report(a!, { answers: 3, hasContent: true }), { type: 'activate', id: a! }, { type: 'activate', id: state.tabs[1]!.id })
    expect(state.tabs[0]!.unread).toBe(false)
    state = run(state, report(a!, { answers: 3 }), report(a!, { answers: 1 }))
    expect(state.tabs[0]!.unread).toBe(false)
  })

  it('marks a background tab unread when its request failed, and never the active tab', () => {
    const state = withTabs(2)
    const [a, b] = ids(state)
    const background = run(state, report(a!, { failed: true, hasContent: true }))
    expect(background.tabs[0]).toMatchObject({ unread: true, failed: true })
    const active = run(state, report(b!, { failed: true }))
    expect(active.tabs[1]).toMatchObject({ unread: false, failed: true })
  })

  it('marks a tab that was already failed only once, and again for a new failure', () => {
    let state = withTabs(2)
    const [a, b] = ids(state)
    state = run(state, report(a!, { failed: true }), { type: 'activate', id: a! })
    expect(state.tabs[0]).toMatchObject({ unread: false, failed: true })
    state = run(state, { type: 'activate', id: b! }, report(a!, { failed: true, working: false }))
    expect(state.tabs[0]!.unread).toBe(false)
    state = run(state, report(a!, { failed: false }))
    expect(state.tabs[0]).toMatchObject({ unread: false, failed: false })
    state = run(state, report(a!, { failed: true }))
    expect(state.tabs[0]).toMatchObject({ unread: true, failed: true })
  })

  it('does not mark a tab whose error was dismissed', () => {
    let state = withTabs(2)
    const [a] = ids(state)
    state = run(state, report(a!, { failed: true }), { type: 'activate', id: a! }, { type: 'activate', id: ids(state)[1]! })
    state = run(state, report(a!, { failed: false }))
    expect(state.tabs[0]!.unread).toBe(false)
  })

  it('ignores a report for a tab that was closed', () => {
    const state = withTabs(2)
    const closed = run(state, { type: 'close', id: ids(state)[0]! })
    expect(run(closed, report(ids(state)[0]!, { answers: 5 }))).toBe(closed)
  })

  it('returns the same state when nothing changes', () => {
    const base = initialTabs()
    expect(run(base, report(base.activeId))).toBe(base)
    const busy = run(base, report(base.activeId, { working: true }))
    expect(run(busy, report(base.activeId, { working: true }))).toBe(busy)
  })
})

describe('tabTitle', () => {
  it('is undefined while there is no message, and otherwise the message', () => {
    expect(tabTitle(undefined)).toBeUndefined()
    expect(tabTitle('')).toBeUndefined()
    expect(tabTitle('   \n  ')).toBeUndefined()
    expect(tabTitle('watch a folder')).toBe('watch a folder')
  })

  it('cuts a long message to about 28 characters with an ellipsis', () => {
    expect(TITLE_MAX).toBe(28)
    const title = tabTitle('When a receipt PDF lands in a folder, put the amount and date in a CSV')!
    expect([...title].length).toBeLessThanOrEqual(TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
    expect(tabTitle('x'.repeat(TITLE_MAX))).toBe('x'.repeat(TITLE_MAX))
  })

  it('does not split a character made of two code units', () => {
    const title = tabTitle(`${'a'.repeat(26)}😀😀😀`)!
    expect(title).not.toMatch(/[\ud800-\udbff]…?$/)
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('collapses white space and keeps markup as plain characters', () => {
    expect(tabTitle('first\n\nsecond\t third')).toBe('first second third')
    expect(tabTitle('<img src=x onerror=alert(1)> and more')).toBe('<img src=x onerror=alert(1)…')
  })

  it('escapes invisible and control characters', () => {
    expect(tabTitle('a‮b\u0000c')).toBe('a‹U+202E›b‹U+0000›c')
    expect(tabTitle('​​')).toBe('‹U+200B›‹U+200B›')
  })
})
