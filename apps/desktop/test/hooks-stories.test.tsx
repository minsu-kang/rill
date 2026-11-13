import { composeStories } from '@storybook/react-vite'
import { act, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import preview from '../.storybook/preview'
import * as module from '../src/app/agents/HooksScreen.stories'
import { createTranslator, type Locale } from '../src/i18n'

type PlayableStory = ComponentType & { play?: (context: { canvasElement: HTMLElement; canvas: ReturnType<typeof within>; userEvent: ReturnType<typeof userEvent.setup> }) => Promise<void> }

const SHOWN: Readonly<Record<string, readonly string[]>> = {
  Empty: ['agents.hooks.list.empty', 'agents.hooks.activity.empty'],
  SomeHooks: ['agents.hooks.screen.engine', 'agents.hooks.activity.outcome.skipped_cooldown', 'agents.hooks.activity.deletedHook'],
  Loading: ['agents.hooks.screen.loading'],
  LoadError: ['agents.hooks.screen.loadError', 'agents.hooks.screen.retry'],
  StaleList: ['agents.hooks.screen.staleError', 'agents.hooks.error.HOOK_NOT_FOUND'],
  ProblemHooks: ['agents.hooks.row.connectionGone'],
  RuleForbidsNotice: ['agents.hooks.row.blockedByRule'],
  AtTheLimit: ['agents.hooks.full'],
  NoticeForm: ['agents.hooks.editor.newTitle', 'agents.hooks.editor.connection.needed', 'agents.hooks.editor.preview'],
  NoticeFormFilled: ['agents.hooks.editor.preview'],
  SwitchOffForm: ['agents.hooks.editor.count.hint'],
  CountOutOfRange: ['agents.hooks.problem.out_of_range'],
  RecordForm: ['agents.hooks.editor.action.record'],
  ChannelProblem: ['agents.hooks.problem.whitespace'],
  WebhookWithChannel: ['agents.hooks.editor.channel.webhook'],
  BotWithoutAChannel: ['agents.hooks.editor.channel.noDefault'],
  DuplicateHook: ['agents.hooks.problem.duplicate'],
  FormWithRuleForbidding: ['agents.hooks.problem.forbidden_by_rule'],
  NoSlackConnection: ['agents.hooks.editor.connection.none', 'agents.hooks.editor.connection.open'],
  NoSlackConnectionPlain: ['agents.hooks.editor.connection.none'],
  ConnectionsNotKnownYet: ['agents.hooks.editor.connection.loading'],
  WorkflowsNotLoaded: ['agents.hooks.editor.scope.error'],
  EditHook: ['agents.hooks.editor.editTitle', 'agents.hooks.editor.unsaved'],
  EditHookWithGoneConnection: ['agents.hooks.problem.unknown_connection'],
  EditWithUnsavedPrompt: ['agents.hooks.unsaved.title', 'agents.hooks.unsaved.cancel'],
  ConfirmDelete: ['agents.hooks.delete.title', 'agents.hooks.delete.note'],
  DeleteFails: ['agents.hooks.error.generic'],
  SaveRefusedAsFull: ['agents.hooks.error.HOOK_FULL'],
  SaveRefusedAsInvalid: ['agents.hooks.problem.unknown_workflow'],
  SaveFails: ['agents.hooks.error.generic'],
  SwitchedOff: ['agents.hooks.status.switchedOff'],
  ActivityLoading: ['agents.hooks.activity.loading'],
  ActivityError: ['agents.hooks.activity.loadError'],
  ActivityMeaning: ['agents.hooks.activity.meaning.skipped_inactive'],
}

describe.each(['en', 'ko'] as const)('the stories of the Hooks screen (%s)', (locale) => {
  const t = createTranslator(locale as Locale)
  const globals = { theme: 'light', locale }
  const composed = composeStories(module, { ...preview, initialGlobals: globals } as never) as unknown as Record<string, PlayableStory>

  it('have a story for every state that the test names, and no name is missing', () => {
    for (const name of Object.keys(SHOWN)) expect(Object.keys(composed), name).toContain(name)
    expect(Object.keys(composed).length).toBeGreaterThanOrEqual(40)
  })

  it.each(Object.entries(SHOWN))('%s shows what it is named for', async (name, keys) => {
    const Story = composed[name]!
    const view = render(<Story />)
    await Story.play?.({ canvasElement: view.container, canvas: within(view.container), userEvent: userEvent.setup() })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const vars = { seconds: 60, actions: 30, minutes: 10, max: 20, count: 3, min: 2, minCount: 2, maxCount: 20, channelMax: 80, connectionMax: 128, name: 'old-slack', summary: '', chars: 60 }
    await waitFor(() => {
      const text = (view.container.textContent ?? '') + (document.body.textContent ?? '')
      for (const key of keys) {
        const sentence = t(key as Parameters<typeof t>[0], vars)
        const head = sentence.split(/\{|‹/)[0]!.trim()
        expect(text, key).toContain(head)
      }
    })
    view.unmount()
  })

  it('shows the message preview with the sentence of the engine, and the preview of a hostile name made safe', async () => {
    const Filled = composed.NoticeFormFilled!
    const first = render(<Filled />)
    await Filled.play?.({ canvasElement: first.container, canvas: within(first.container), userEvent: userEvent.setup() })
    await waitFor(() => expect(first.container.textContent).toContain('Workflow "웹훅을 슬랙으로 전달" was deployed.'))
    expect((first.container.querySelector('[data-hook-field="channel"]') as HTMLInputElement).value).toBe('#releases')
    first.unmount()
    const Hostile = composed.NoticeFormHostileName!
    const second = render(<Hostile />)
    await Hostile.play?.({ canvasElement: second.container, canvas: within(second.container), userEvent: userEvent.setup() })
    await waitFor(() => expect(second.container.textContent).toContain('Workflow "&lt;img src=x onerror=alert(1)&gt; gpj&lt;/b&gt; {{secret}}" failed.'))
    expect(second.container.querySelector('img, script')).toBeNull()
  })
})
