import { composeStories, type Meta } from '@storybook/react-vite'
import { act, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { join } from 'node:path'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import preview from '../.storybook/preview'
import { explainCases } from '../src/fixtures/explain'
import { createTranslator, type Locale, type Translate } from '../src/i18n'

type StoryModule = { default: Meta } & Record<string, unknown>
type PlayableStory = ComponentType & { play?: (context: { canvasElement: HTMLElement; canvas: ReturnType<typeof within>; userEvent: ReturnType<typeof userEvent.setup> }) => Promise<void> }

export const SRC = join(import.meta.dirname, '../src')
export const COMPONENT_DIRS = ['graph', 'inspector', 'runs', 'workspace', 'ui', 'explain', 'recipes', 'chat']
export const modules = import.meta.glob<StoryModule>('../src/**/*.stories.tsx', { eager: true })
export const MODES = [
  { name: 'Korean, light', globals: { theme: 'light', locale: 'ko' } },
  { name: 'English, dark', globals: { theme: 'dark', locale: 'en' } },
] as const

const KEY_LIKE = /\b(?:app|status|run|badge|node|graph|inspector|json|history|time|workspace|explain|recipes|chat|agents|rules|skills)\.[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*/g
const EVENT_NAMES = new Set(['run.started', 'run.finished'])

export function untranslated(text: string): string[] {
  return (text.match(KEY_LIKE) ?? []).filter((found) => !EVENT_NAMES.has(found))
}

export function stories(globals: Record<string, string>): Array<{ file: string; name: string; Story: PlayableStory }> {
  const found: Array<{ file: string; name: string; Story: PlayableStory }> = []
  for (const [file, module] of Object.entries(modules)) {
    const composed = composeStories(module, { ...preview, initialGlobals: globals } as never) as unknown as Record<string, PlayableStory>
    for (const [name, Story] of Object.entries(composed)) found.push({ file: file.replace('../src/', ''), name, Story })
  }
  return found
}

export const EXPLAIN_PANEL = 'explain/ExplainPanel.stories.tsx'
export const PLAYED: Readonly<Record<string, (t: Translate) => string[]>> = {
  [`${EXPLAIN_PANEL} NoticeBeforeFirstRequest`]: (t) => [t('explain.notice.heading'), t('explain.notice.send'), 'anthropic · claude-sonnet-5'],
  [`${EXPLAIN_PANEL} NoticeProviderUnknown`]: (t) => [t('explain.notice.targetUnknown'), t('explain.notice.send')],
  [`${EXPLAIN_PANEL} Loading`]: (t) => [t('explain.progress'), t('explain.dismissWarning')],
  [`${EXPLAIN_PANEL} AnswerWithThreeActions`]: (t) => [explainCases.threeActions.explanation, t('explain.card.actions')],
  [`${EXPLAIN_PANEL} AnswerWithFixProposal`]: (t) => [t('explain.fix.heading'), t('explain.fix.hidden'), t('explain.card.hidden')],
  [`${EXPLAIN_PANEL} AnswerHostileText`]: (t) => [t('explain.card.cause'), t('explain.fix.heading')],
  [`${EXPLAIN_PANEL} ErrorNotFound`]: (t) => [t('explain.error.notFound'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorNotExplainable`]: (t) => [t('explain.error.notExplainable'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorProviderMissing`]: (t) => [t('explain.error.llmUnavailable'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorBusy`]: (t) => [t('explain.error.busy'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorProvider`]: (t) => [t('explain.error.provider'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorInvalidAnswer`]: (t) => [t('explain.error.invalid'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorInvalidParams`]: (t) => [t('explain.error.params'), t('explain.retry')],
  [`${EXPLAIN_PANEL} ErrorOther`]: (t) => [t('explain.error.generic'), t('explain.retry')],
  'explain/ExplainCard.stories.tsx ConfirmStepOpen': (t) => [t('explain.confirm.yes'), t('explain.confirm.no')],
  'explain/ActionButtons.stories.tsx ConfirmRetry': (t) => [t('explain.confirm.retry_run'), t('explain.confirm.yes')],
  'explain/ActionButtons.stories.tsx ConfirmDeactivate': (t) => [t('explain.confirm.deactivate_workflow'), t('explain.confirm.yes')],
  'recipes/RecipeGallery.stories.tsx SearchWithNoMatch': (t) => [t('recipes.noMatch')],
  'recipes/RecipePanel.stories.tsx GoogleRecipeFormOpened': (t) => [t('recipes.form.submit'), t('recipes.form.back'), 'Google (someone@example.com)'],
  'recipes/RecipePanel.stories.tsx ExcelRecipeFormOpened': (t) => [t('recipes.form.submit'), t('recipes.form.back'), t('recipes.field.accountReconnectNote', { kind: t('recipes.kind.microsoft') })],
  'recipes/RecipePanel.stories.tsx FormOpened': (t) => [t('recipes.form.submit'), t('recipes.form.back')],
  'recipes/RecipePanel.stories.tsx ServerProblemsAtFields': (t) => [t('recipes.rule.not_absolute_path'), t('recipes.rule.wrong_extension'), t('recipes.form.submit')],
}

export const APP_SCREEN = 'app/App.stories.tsx'
export const SHOWN: Readonly<Record<string, (t: Translate) => string[]>> = {
  [`${APP_SCREEN} FirstRun`]: (t) => [t('app.top.engine.connected'), t('app.firstRun.title'), t('app.firstRun.folder.action'), t('app.wf.switcher.empty')],
  [`${APP_SCREEN} Ready`]: (t) => [t('app.top.engine.connected'), t('app.wf.actions.dryRun'), t('app.wf.actions.runNow'), 'Extract fields with AI'],
  [`${APP_SCREEN} FailedRunWithExplanation`]: (t) => [t('app.top.engine.connected'), t('explain.card.cause'), explainCases.configuration.explanation],
  [`${APP_SCREEN} EngineRestarting`]: (t) => [t('app.top.engine.restarting'), t('app.chat.connecting'), t('app.main.connecting')],
  [`${APP_SCREEN} EngineStopped`]: (t) => [t('app.top.engine.stopped'), t('app.engine.error.crashed'), t('app.top.engine.restart')],
  [`${APP_SCREEN} NoKeychain`]: (t) => [t('app.top.engine.stopped'), t('app.engine.error.no_keychain'), t('app.settings.noKeychain.title'), t('app.keys.heading')],
  [`${APP_SCREEN} NarrowWindow`]: (t) => [t('app.top.engine.connected'), t('app.top.chat.close'), t('app.wf.actions.dryRun')],
  [`${APP_SCREEN} RecipesScreen`]: (t) => [t('recipes.heading'), t('recipes.search')],
  [`${APP_SCREEN} SettingsFolders`]: (t) => [t('app.top.engine.connected'), t('app.settings.section.folders'), t('app.folders.intro')],
  [`${APP_SCREEN} SettingsModel`]: (t) => [t('app.top.engine.connected'), t('app.settings.section.model'), t('app.model.intro')],
  [`${APP_SCREEN} SettingsKeys`]: (t) => [t('app.top.engine.connected'), t('app.settings.section.keys'), t('app.keys.intro')],
  [`${APP_SCREEN} SettingsConnections`]: (t) => [t('app.top.engine.connected'), t('app.settings.section.connections'), t('app.connections.intro')],
  [`${APP_SCREEN} GeneralSettings`]: (t) => [t('app.general.heading'), t('app.general.language'), t('app.general.openAtLogin')],
  [`${APP_SCREEN} NarrowRecipes`]: (t) => [t('recipes.heading'), t('recipes.search')],
  [`${APP_SCREEN} OneWorkflow`]: (t) => [t('app.top.engine.connected'), '영수증 정리', t('app.wf.trigger.folderWatch'), t('app.wf.actions.dryRun')],
  [`${APP_SCREEN} TwoWorkflows`]: (t) => [t('app.top.engine.connected'), '웹훅을 슬랙으로 전달', t('app.wf.trigger.webhook'), t('app.wf.actions.activate')],
  [`${APP_SCREEN} ReconnectNoticeGoogle`]: (t) => [t('app.top.engine.connected'), t('app.notice.reconnect', { provider: 'Google' }), t('app.notice.reconnect.action'), t('app.wf.actions.dryRun')],
  [`${APP_SCREEN} ReconnectNoticeMicrosoft`]: (t) => [t('app.top.engine.connected'), t('app.notice.reconnect', { provider: 'Microsoft' }), t('app.notice.reconnect.action'), t('app.wf.actions.dryRun')],
  [`${APP_SCREEN} ReconnectNoticeBoth`]: (t) => [t('app.top.engine.connected'), t('app.notice.reconnectBoth'), t('app.notice.reconnect.action'), t('app.wf.actions.dryRun')],
  [`${APP_SCREEN} ReconnectNoticeNarrow`]: (t) => [t('app.top.engine.connected'), t('app.notice.reconnectBoth'), t('app.notice.reconnect.action'), t('app.wf.actions.dryRun')],
  [`${APP_SCREEN} ReconnectActionOpensConnections`]: (t) => [t('app.top.engine.connected'), t('app.settings.section.connections'), t('app.connections.intro'), t('app.oauth.status.needs_reconnect')],
  [`${APP_SCREEN} LongWorkflowName`]: (t) => [t('app.top.engine.connected'), '매일 아침 받은 편지함의 영수증을 모아서', t('app.wf.actions.dryRun')],
}

export const STORY_RENDER_PARTS = 6

export function registerStoryRenders(part: number): void {
  describe.each(MODES)('every story renders without an error or a warning ($name)', (mode) => {
    let errors: ReturnType<typeof vi.spyOn>
    let warnings: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      errors.mockRestore()
      warnings.mockRestore()
    })

    for (const [index, { file, name, Story }] of stories(mode.globals).entries()) {
      if (index % STORY_RENDER_PARTS !== part) continue
      it(`${file} ${name}`, async () => {
        const view = render(<Story />)
        await Story.play?.({ canvasElement: view.container, canvas: within(view.container), userEvent: userEvent.setup() })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40))
        })
        const translate = createTranslator(mode.globals.locale as Locale)
        const shown = SHOWN[`${file} ${name}`]?.(translate) ?? []
        if (shown.length > 0) {
          await waitFor(
            () => {
              const now = view.container.textContent ?? ''
              for (const phrase of shown) expect(now, phrase).toContain(phrase)
            },
            { timeout: 8000 },
          )
        }
        const text = view.container.textContent ?? ''
        const wanted = PLAYED[`${file} ${name}`]?.(translate) ?? []
        const pressed = view.container.querySelectorAll('[aria-pressed="true"]').length
        const attributes = [...view.container.querySelectorAll('[aria-label], [title]')].map((item) => `${item.getAttribute('aria-label') ?? ''}\n${item.getAttribute('title') ?? ''}`).join('\n')
        const wrapper = view.container.querySelector('[data-theme]')
        const drawn = wrapper?.querySelectorAll('*').length ?? 0
        view.unmount()
        expect(drawn).toBeGreaterThan(0)
        expect(wrapper?.getAttribute('data-theme')).toBe(mode.globals.theme)
        expect(wrapper?.getAttribute('lang')).toBe(mode.globals.locale)
        for (const phrase of wanted) expect(text, phrase).toContain(phrase)
        if (file === 'recipes/RecipeGallery.stories.tsx' && name === 'TagFilterOn') expect(pressed).toBe(1)
        expect(untranslated(text)).toEqual([])
        expect(untranslated(attributes)).toEqual([])
        expect(attributes).not.toMatch(/Edge from|Node from/)
        expect([...errors.mock.calls, ...warnings.mock.calls].map((call) => String(call[0]).slice(0, 300))).toEqual([])
      })
    }
  })
}
