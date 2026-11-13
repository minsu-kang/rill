import type { Meta, StoryObj } from '@storybook/react-vite'
import { useReducer } from 'react'
import { ChatTabs, type ChatTabsProps } from './ChatTabs'
import { canOpenTab, initialTabs, MAX_TABS, tabsReducer, type TabsState } from './model/tabs'

interface Spec {
  message?: string
  working?: boolean
  unread?: boolean
}

function seeded(specs: readonly Spec[], active = 0): () => TabsState {
  return () => {
    let state = initialTabs()
    for (let index = 1; index < specs.length; index += 1) state = tabsReducer(state, { type: 'open' })
    const ids = state.tabs.map((tab) => tab.id)
    state = tabsReducer(state, { type: 'activate', id: ids[active]! })
    specs.forEach((spec, index) => {
      state = tabsReducer(state, { type: 'report', id: ids[index]!, firstMessage: spec.message, working: spec.working === true, hasContent: spec.message !== undefined, answers: spec.unread === true ? 1 : 0 })
    })
    return state
  }
}

function Demo({ build, width = 380 }: { build: () => TabsState; width?: number }) {
  const [state, dispatch] = useReducer(tabsReducer, undefined, build)
  return (
    <div style={{ width, border: '1px solid var(--border-default)', background: 'var(--surface-base)' }}>
      <ChatTabs
        tabs={state.tabs}
        activeId={state.activeId}
        tabDomId={(id) => `story-tab-${id}`}
        panelDomId={(id) => `story-panel-${id}`}
        canOpen={canOpenTab(state)}
        focusSignal={0}
        onActivate={(id) => dispatch({ type: 'activate', id })}
        onClose={(id) => dispatch({ type: 'close', id })}
        onOpen={() => dispatch({ type: 'open' })}
      />
    </div>
  )
}

const meta = { title: 'Chat/ChatTabs', component: ChatTabs } satisfies Meta<typeof ChatTabs>

export default meta

type Story = StoryObj<typeof meta>

const unused = {} as ChatTabsProps

const MESSAGES = [
  '폴더에 영수증 PDF가 들어오면 CSV에 정리해 줘',
  'Every morning at 9, check my server',
  'When an order arrives by webhook',
  '슬랙으로 알려 줘',
  'Monthly reminder on the first day',
  'Failure alerts for the health check',
  '장부 파일 백업',
  'Weekly report to Slack',
]

export const OneTab: Story = { name: 'One tab', args: unused, render: () => <Demo build={seeded([{}])} /> }

export const ThreeTabs: Story = { name: 'Three tabs', args: unused, render: () => <Demo build={seeded([{ message: MESSAGES[0] }, { message: MESSAGES[1] }, {}], 1)} /> }

export const EightTabsAtTheLimit: Story = {
  name: 'Eight tabs (at the limit)',
  args: unused,
  render: () => <Demo build={seeded(MESSAGES.slice(0, MAX_TABS).map((message) => ({ message })), 3)} />,
}

export const WorkingAndUnread: Story = {
  name: 'Working and unread',
  args: unused,
  render: () => <Demo build={seeded([{ message: MESSAGES[0], working: true }, { message: MESSAGES[1], unread: true }, { message: MESSAGES[2] }, {}], 2)} />,
}

export const NarrowPanel: Story = { name: 'Narrow panel (360 px)', args: unused, render: () => <Demo width={360} build={seeded([{ message: MESSAGES[0], working: true }, { message: MESSAGES[1], unread: true }, { message: MESSAGES[2] }, { message: MESSAGES[3] }], 3)} /> }

export const HostileTitles: Story = {
  name: 'Hostile titles',
  args: unused,
  render: () => <Demo build={seeded([{ message: '<img src=x onerror=alert(1)> <b>bold</b>' }, { message: 'a‮b​c \u0000 control' }, { message: 'x'.repeat(200) }])} />,
}
