import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { FAKE_DEPLOYED_ID, withRecipeMethods } from '../src/engine/fake-recipes'
import { catalog, fakeData } from '../src/fixtures'
import { failingInstantiate, fixtureRecipeData, hostileRecipes, recipeInfos, recipeProblemSets } from '../src/fixtures/recipes'
import { createTranslator } from '../src/i18n'
import { ko } from '../src/i18n/ko'
import { RecipePanel, type RecipePanelProps } from '../src/recipes/RecipePanel'
import { renderThemed } from './render'

const t = createTranslator('ko')
const BIG = recipeInfos.find((recipe) => recipe.id === 'receipt-big-amount-alert')!
const HEALTH = recipeInfos.find((recipe) => recipe.id === 'daily-health-check')!
const CONNECTIONS: RecipePanelProps['connections'] = [{ name: 'slack-ops', kind: 'slack' }]

function spied(client: EngineClient) {
  const calls: Array<{ method: string; params: unknown }> = []
  const answers: Array<Promise<unknown>> = []
  const wrapped: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>) => {
      calls.push({ method, params })
      const answer = client.request(method, params)
      answers.push(answer.then(() => undefined, () => undefined))
      return answer
    },
    onEvent: (listener) => client.onEvent(listener),
  }
  return { client: wrapped, calls, answered: () => Promise.all(answers) }
}

function setup(overrides: Partial<RecipePanelProps> = {}, data = fixtureRecipeData(), locale: 'ko' | 'en' = 'ko') {
  const { client, calls, answered } = spied(withRecipeMethods(createFakeClient(fakeData), data))
  const onDeployed = vi.fn()
  const onAction = vi.fn()
  const props: RecipePanelProps = { client, catalog, connections: CONNECTIONS, onDeployed, onAction, ...overrides }
  const view = renderThemed(<RecipePanel {...props} />, { locale })
  return { calls, answered, onDeployed, onAction, view, user: userEvent.setup(), props }
}

const choose = (user: ReturnType<typeof userEvent.setup>, title: string) => user.click(screen.getByRole('button', { name: t('recipes.card.chooseLabel', { title }) }))

async function fillHealth(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(HEALTH.params[1]!.label.ko), 'https://example.test/health')
  await user.selectOptions(screen.getByLabelText(HEALTH.params[2]!.label.ko), 'slack-ops')
}

describe('RecipePanel gallery', () => {
  it('shows loading and then the six recipes', async () => {
    setup()
    expect(screen.getByRole('status').textContent).toContain(ko['recipes.loading'])
    expect(await screen.findAllByRole('article')).toHaveLength(6)
  })

  it('shows an error with a retry that loads again', async () => {
    let fail = true
    const data = fixtureRecipeData()
    const base = withRecipeMethods(createFakeClient(fakeData), data)
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: <M extends MethodName>(method: M, params: MethodParams<M>) => (fail && method === 'listRecipes' ? Promise.reject(new RillError('INTERNAL', 'boom')) : base.request(method, params)),
    }
    const user = userEvent.setup()
    renderThemed(<RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} />)
    expect((await screen.findByRole('alert')).textContent).toContain(ko['recipes.loadError'])
    fail = false
    await user.click(screen.getByRole('button', { name: ko['recipes.retry'] }))
    expect(await screen.findAllByRole('article')).toHaveLength(6)
  })

  it('shows recipe titles with HTML from the server as text', async () => {
    const { view } = setup({}, { ...fixtureRecipeData(), recipes: hostileRecipes })
    await screen.findAllByRole('article')
    expect(view.container.querySelector('img, script, a')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x onerror=')
  })
})

describe('RecipePanel flow', () => {
  it('goes from the gallery to the form, the draft preview, the deploy and the actions', async () => {
    const { user, calls, onDeployed, onAction } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    expect(screen.getByRole('heading', { name: t('recipes.form.heading', { title: HEALTH.title.ko }) })).toBeTruthy()
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    expect(await screen.findByRole('heading', { name: ko['recipes.preview.heading'] })).toBeTruthy()
    expect(calls.find((call) => call.method === 'instantiateRecipe')!.params).toEqual({
      recipeId: HEALTH.id,
      values: { schedule: '0 9 * * 1-5', url: 'https://example.test/health', slackConnection: 'slack-ops' },
    })
    expect(calls.filter((call) => call.method === 'deploy')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.deploy'] }))
    expect(await screen.findByText(t('recipes.preview.deployed', { id: FAKE_DEPLOYED_ID }))).toBeTruthy()
    expect(onDeployed).toHaveBeenCalledWith(FAKE_DEPLOYED_ID)
    expect(calls.filter((call) => call.method === 'deploy')).toHaveLength(1)
    expect(calls.some((call) => call.method === 'startRun' || call.method === 'activate')).toBe(false)
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.dryRun'] }))
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.activate'] }))
    expect(onAction.mock.calls).toEqual([['dry_run', FAKE_DEPLOYED_ID], ['activate', FAKE_DEPLOYED_ID]])
    expect(calls.some((call) => call.method === 'startRun' || call.method === 'activate')).toBe(false)
  })

  it('deploys once when the deploy button is pressed twice quickly', async () => {
    const { user, calls } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    const button = await screen.findByRole('button', { name: ko['recipes.preview.deploy'] })
    await act(async () => {
      button.click()
      button.click()
    })
    await screen.findByText(t('recipes.preview.deployed', { id: FAKE_DEPLOYED_ID }))
    expect(calls.filter((call) => call.method === 'deploy')).toHaveLength(1)
  })

  it('creates one draft when the submit button is pressed twice quickly', async () => {
    const { user, calls } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    const button = screen.getByRole('button', { name: ko['recipes.form.submit'] })
    await act(async () => {
      button.click()
      button.click()
    })
    await screen.findByRole('heading', { name: ko['recipes.preview.heading'] })
    expect(calls.filter((call) => call.method === 'instantiateRecipe')).toHaveLength(1)
  })

  it('keeps the typed values when going back from the preview', async () => {
    const { user } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.edit'] }))
    expect((screen.getByLabelText(HEALTH.params[1]!.label.ko) as HTMLInputElement).value).toBe('https://example.test/health')
    expect((screen.getByLabelText(HEALTH.params[2]!.label.ko) as HTMLSelectElement).value).toBe('slack-ops')
  })

  it('starts the form fresh when the recipe is chosen again from the gallery', async () => {
    const { user } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await user.type(screen.getByLabelText(HEALTH.params[1]!.label.ko), 'https://example.test/x')
    await user.click(screen.getByRole('button', { name: ko['recipes.form.back'] }))
    await choose(user, HEALTH.title.ko)
    expect((screen.getByLabelText(HEALTH.params[1]!.label.ko) as HTMLInputElement).value).toBe('')
  })

  it('returns to the gallery after a deploy when asked', async () => {
    const { user } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.deploy'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.another'] }))
    expect(await screen.findAllByRole('article')).toHaveLength(6)
  })

  it('shows RECIPE_INVALID problems at the fields and in the general list and keeps the values', async () => {
    const problems = [...recipeProblemSets.folderAndFile.slice(0, 1), ...recipeProblemSets.pathIssues]
    const { user } = setup({}, { ...fixtureRecipeData(), instantiate: failingInstantiate(['watchFolder: not_absolute_path', ...recipeProblemSets.pathIssues]) })
    await screen.findAllByRole('article')
    await choose(user, BIG.title.ko)
    await user.type(screen.getByLabelText(BIG.params[0]!.label.ko), 'relative/dir')
    await user.type(screen.getByLabelText(BIG.params[2]!.label.ko), '/Users/demo/ledger.csv')
    await user.type(screen.getByLabelText(BIG.params[3]!.label.ko), '250')
    await user.selectOptions(screen.getByLabelText(BIG.params[4]!.label.ko), 'slack-ops')
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    expect(await screen.findByText(ko['recipes.rule.not_absolute_path'])).toBeTruthy()
    const list = screen.getByRole('list', { name: ko['recipes.form.general'] })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect((screen.getByLabelText(BIG.params[0]!.label.ko) as HTMLInputElement).value).toBe('relative/dir')
    expect((screen.getByLabelText(BIG.params[3]!.label.ko) as HTMLInputElement).value).toBe('250')
    expect(problems.length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: ko['recipes.preview.heading'] })).toBeNull()
  })

  it('shows a notice for a failure that is not about a value and lets the user try again', async () => {
    let first = true
    const data = fixtureRecipeData()
    const { user } = setup({}, {
      ...data,
      instantiate: (params) => {
        if (first) {
          first = false
          return new RillError('INTERNAL', 'SERVER-TEXT-MARKER')
        }
        return data.instantiate(params)
      },
    })
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(ko['recipes.error.generic'])
    expect(document.body.textContent).not.toContain('SERVER-TEXT-MARKER')
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    expect(await screen.findByRole('heading', { name: ko['recipes.preview.heading'] })).toBeTruthy()
  })

  it('shows a deploy failure and lets the user deploy again', async () => {
    const data = fixtureRecipeData()
    const base = withRecipeMethods(createFakeClient(fakeData), data)
    let failDeploy = true
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
        method === 'deploy' && failDeploy ? Promise.reject(new RillError('INVALID_WORKFLOW', 'SERVER-TEXT-MARKER')) : (base.request(method, params) as Promise<MethodResult<M>>),
    }
    const user = userEvent.setup()
    renderThemed(<RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} />)
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.deploy'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(ko['recipes.deployError.invalid'])
    expect(document.body.textContent).not.toContain('SERVER-TEXT-MARKER')
    failDeploy = false
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.deploy'] }))
    expect(await screen.findByText(t('recipes.preview.deployed', { id: FAKE_DEPLOYED_ID }))).toBeTruthy()
  })

  it('works without the optional callbacks', async () => {
    const { client } = spied(withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData()))
    const user = userEvent.setup()
    renderThemed(<RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} />)
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.deploy'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.activate'] }))
    expect(screen.getByText(t('recipes.preview.deployed', { id: FAKE_DEPLOYED_ID }))).toBeTruthy()
  })

  it('sets no state when it unmounts while a request is open', async () => {
    const pending: Array<() => void> = []
    const base = withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData())
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
        method === 'instantiateRecipe'
          ? new Promise<MethodResult<M>>((resolve) => {
              pending.push(() => void base.request(method, params).then(resolve))
            })
          : base.request(method, params),
    }
    const user = userEvent.setup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = renderThemed(<RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} />)
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    view.unmount()
    pending.forEach((release) => release())
    await waitFor(() => expect(pending.length).toBe(1))
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('does not tell the host about a deploy that finishes after the panel is gone', async () => {
    const release: Array<() => void> = []
    const base = withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData())
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: <M extends MethodName>(method: M, params: MethodParams<M>) =>
        method === 'deploy'
          ? new Promise<MethodResult<M>>((resolve) => {
              release.push(() => void base.request(method, params).then(resolve))
            })
          : base.request(method, params),
    }
    const onDeployed = vi.fn()
    const user = userEvent.setup()
    const view = renderThemed(<RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} onDeployed={onDeployed} />)
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.deploy'] }))
    view.unmount()
    release.forEach((fn) => fn())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(onDeployed).not.toHaveBeenCalled()
  })
})

describe('RecipePanel focus', () => {
  const focused = () => document.activeElement
  const submitForm = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: ko['recipes.form.submit'] }))

  it('takes no focus when the gallery first appears', async () => {
    setup()
    await screen.findAllByRole('article')
    expect(focused()).toBe(document.body)
  })

  it('follows the person through the gallery, the form, the preview, the deploy and back', async () => {
    const { user } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    expect(focused()).toBe(screen.getByRole('heading', { name: t('recipes.form.heading', { title: HEALTH.title.ko }) }))
    await fillHealth(user)
    await submitForm(user)
    const preview = await screen.findByRole('heading', { name: ko['recipes.preview.heading'] })
    expect(focused()).toBe(preview)
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.edit'] }))
    expect(focused()).toBe(screen.getByRole('heading', { name: t('recipes.form.heading', { title: HEALTH.title.ko }) }))
    await submitForm(user)
    await user.click(await screen.findByRole('button', { name: ko['recipes.preview.deploy'] }))
    const deployed = await screen.findByRole('status')
    expect(deployed.textContent).toContain(FAKE_DEPLOYED_ID)
    expect(focused()).toBe(deployed)
    await user.click(screen.getByRole('button', { name: ko['recipes.preview.another'] }))
    expect(focused()).toBe(await screen.findByRole('heading', { name: ko['recipes.heading'] }))
  })

  it('returns to the gallery heading from the form', async () => {
    const { user } = setup()
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await user.click(screen.getByRole('button', { name: ko['recipes.form.back'] }))
    expect(focused()).toBe(screen.getByRole('heading', { name: ko['recipes.heading'] }))
  })

  it('keeps focus where it is when a problem comes back to the form', async () => {
    const { user, answered } = setup({}, { ...fixtureRecipeData(), instantiate: failingInstantiate(['url: bad_url']) })
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    const button = screen.getByRole('button', { name: ko['recipes.form.submit'] })
    button.focus()
    await act(async () => {
      fireEvent.click(button)
      await answered()
    })
    await screen.findByText(ko['recipes.rule.bad_url'])
    expect(focused()).toBe(button)
  })

  it.fails('PRODUCT GAP: loses the focus when the engine takes longer than a frame to answer, because the submit button is disabled meanwhile', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const base = withRecipeMethods(createFakeClient(fakeData), { ...fixtureRecipeData(), instantiate: failingInstantiate(['url: bad_url']) })
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: <M extends MethodName>(method: M, params: MethodParams<M>) => (method === 'instantiateRecipe' ? gate.then(() => base.request(method, params)) : base.request(method, params)),
    }
    const user = userEvent.setup()
    renderThemed(<RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} />)
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    const button = screen.getByRole('button', { name: ko['recipes.form.submit'] })
    await user.click(button)
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))
    for (let frame = 0; frame < 2; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve))
    await act(async () => release())
    await screen.findByText(ko['recipes.rule.bad_url'])
    expect(focused()).toBe(button)
  })

  it('does not take focus from another place when the preview arrives', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const base = withRecipeMethods(createFakeClient(fakeData), fixtureRecipeData())
    const client: EngineClient = {
      onEvent: (listener) => base.onEvent(listener),
      request: <M extends MethodName>(method: M, params: MethodParams<M>) => (method === 'instantiateRecipe' ? gate.then(() => base.request(method, params)) : base.request(method, params)),
    }
    const user = userEvent.setup()
    renderThemed(
      <>
        <button type="button">outside</button>
        <RecipePanel client={client} catalog={catalog} connections={CONNECTIONS} />
      </>,
    )
    await screen.findAllByRole('article')
    await choose(user, HEALTH.title.ko)
    await fillHealth(user)
    await submitForm(user)
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()
    await act(async () => release())
    await screen.findByRole('heading', { name: ko['recipes.preview.heading'] })
    expect(focused()).toBe(outside)
  })
})
