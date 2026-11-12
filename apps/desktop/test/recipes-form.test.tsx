import type { RecipeInfo, RecipeValues } from '@rill/protocol'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { hostileRecipes, recipeInfos, recipeProblemSets } from '../src/fixtures/recipes'
import { createTranslator } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { initialValues, type FormValues, type HostConnection } from '../src/recipes/model/values'
import { RecipeForm, type RecipeFormProps } from '../src/recipes/RecipeForm'
import { violations } from './axe'
import { renderThemed } from './render'

const t = createTranslator('ko')
const recipe = (id: string): RecipeInfo => recipeInfos.find((item) => item.id === id)!
const BIG = recipe('receipt-big-amount-alert')
const HEALTH = recipe('daily-health-check')
const REMINDER = recipe('monthly-reminder')
const CONNECTIONS: HostConnection[] = [
  { name: 'slack-ops', kind: 'slack' },
  { name: 'slack-dev', kind: 'slack' },
  { name: 'api-main', kind: 'http' },
]

function Harness({ info, initial, ...rest }: Partial<RecipeFormProps> & { info: RecipeInfo; initial?: FormValues }) {
  const [values, setValues] = useState<FormValues>(initial ?? initialValues(info.params))
  return (
    <RecipeForm
      recipe={info}
      values={values}
      onValuesChange={setValues}
      connections={CONNECTIONS}
      onSubmit={vi.fn()}
      onBack={vi.fn()}
      {...rest}
    />
  )
}

function setup(info: RecipeInfo, props: Partial<RecipeFormProps> = {}, locale: 'ko' | 'en' = 'ko', initial?: FormValues) {
  const view = renderThemed(<Harness info={info} initial={initial} {...props} />, { locale })
  return { view, user: userEvent.setup() }
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement
const submit = () => screen.getByRole('button', { name: ko['recipes.form.submit'] }) as HTMLButtonElement

async function fillBig(user: ReturnType<typeof userEvent.setup>) {
  await user.type(field(BIG.params[0]!.label.ko), '/Users/demo/Receipts')
  await user.type(field(BIG.params[2]!.label.ko), '/Users/demo/ledger.csv')
  await user.type(field(BIG.params[3]!.label.ko), '250')
  await user.selectOptions(field(BIG.params[4]!.label.ko), 'slack-ops')
}

describe('RecipeForm fields', () => {
  it('renders a field for every param kind with the label and help of the current language', () => {
    setup(BIG)
    for (const param of BIG.params) {
      expect(field(param.label.ko), param.id).toBeTruthy()
      expect(screen.getByText(param.help!.ko), param.id).toBeTruthy()
    }
    expect(field(BIG.params[0]!.label.ko).tagName).toBe('INPUT')
    expect(field(BIG.params[4]!.label.ko).tagName).toBe('SELECT')
  })

  it('shows English labels and help in English', () => {
    setup(BIG, {}, 'en')
    for (const param of BIG.params) {
      expect(screen.getByLabelText(param.label.en), param.id).toBeTruthy()
      expect(screen.getByText(param.help!.en), param.id).toBeTruthy()
    }
    expect(screen.queryByLabelText(BIG.params[0]!.label.ko)).toBeNull()
    expect(screen.getByRole('button', { name: en['recipes.form.submit'] })).toBeTruthy()
  })

  it('prefills defaults and leaves other fields empty', () => {
    setup(BIG)
    expect(field(BIG.params[1]!.label.ko).value).toBe('*.pdf')
    expect(field(BIG.params[0]!.label.ko).value).toBe('')
  })

  it('marks required and optional fields', () => {
    setup(BIG)
    expect(field(BIG.params[0]!.label.ko).getAttribute('aria-required')).toBe('true')
    expect(field(BIG.params[1]!.label.ko).getAttribute('aria-required')).toBeNull()
    expect(screen.getAllByText(ko['recipes.form.required']).length).toBe(BIG.params.filter((param) => param.required).length)
  })

  it('shows the range of a number and the extension of a file', () => {
    setup(BIG)
    expect(screen.getByText(t('recipes.field.range', { min: 0, max: '1,000,000,000,000' }))).toBeTruthy()
    expect(screen.getByText(t('recipes.field.extension', { extension: '.csv' }))).toBeTruthy()
  })

  it('offers cron presets that fill the text field, and keeps the field editable', async () => {
    const { user } = setup(HEALTH)
    const cron = field(HEALTH.params[0]!.label.ko)
    expect(cron.value).toBe('0 9 * * 1-5')
    const preset = screen.getByLabelText(ko['recipes.field.cronPreset']) as HTMLSelectElement
    expect([...preset.options].length).toBeGreaterThanOrEqual(4)
    await user.selectOptions(preset, ko['recipes.cron.monthly'])
    expect(cron.value).toBe('0 9 1 * *')
    await user.clear(cron)
    await user.type(cron, '5 4 * * *')
    expect(cron.value).toBe('5 4 * * *')
    expect(preset.value).toBe('')
    expect(screen.getByText(ko['recipes.field.cronNote'])).toBeTruthy()
  })

  it('shows the preset that matches the text of the cron field', () => {
    setup(REMINDER)
    expect((screen.getByLabelText(ko['recipes.field.cronPreset']) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe(ko['recipes.cron.monthly'])
  })

  it('has a url field and a text field', () => {
    setup(HEALTH)
    expect(field(HEALTH.params[1]!.label.ko).tagName).toBe('INPUT')
    setup(REMINDER)
    expect(field(REMINDER.params[1]!.label.ko).value).toBe(REMINDER.params[1]!.default)
  })
})

describe('RecipeForm connections', () => {
  it('lists only the connections of the matching kind', () => {
    setup(BIG)
    const select = field(BIG.params[4]!.label.ko) as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'slack-ops', 'slack-dev'])
  })

  it('says so and offers no free text when no connection matches', () => {
    setup(BIG, { connections: [{ name: 'api-main', kind: 'http' }] })
    expect(screen.getByText(t('recipes.field.noConnection', { kind: ko['recipes.kind.slack'] }))).toBeTruthy()
    expect(screen.queryByLabelText(BIG.params[4]!.label.ko)).toBeNull()
    expect(submit().disabled).toBe(true)
  })

  it('says so when the host gave no connections at all', () => {
    setup(HEALTH, { connections: [] })
    expect(screen.getByText(t('recipes.field.noConnection', { kind: ko['recipes.kind.slack'] }))).toBeTruthy()
  })
})

describe('RecipeForm path pickers', () => {
  it('has no choose button without onPickPath, and a plain text input', () => {
    setup(BIG)
    expect(screen.queryByRole('button', { name: new RegExp(ko['recipes.field.choose']) })).toBeNull()
  })

  it('fills the field with the picked path and passes the kind of the field', async () => {
    const onPickPath = vi.fn(async () => '/Users/demo/Picked')
    const { user } = setup(BIG, { onPickPath })
    await user.click(screen.getByRole('button', { name: `${BIG.params[0]!.label.ko} ${ko['recipes.field.choose']}` }))
    expect(onPickPath).toHaveBeenCalledWith('folder')
    expect(field(BIG.params[0]!.label.ko).value).toBe('/Users/demo/Picked')
    await user.click(screen.getByRole('button', { name: `${BIG.params[2]!.label.ko} ${ko['recipes.field.choose']}` }))
    expect(onPickPath).toHaveBeenLastCalledWith('file')
  })

  it('keeps the text when the picker is cancelled or fails', async () => {
    const onPickPath = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'))
    const { user } = setup(BIG, { onPickPath }, 'ko', { ...initialValues(BIG.params), watchFolder: '/keep' })
    const button = screen.getByRole('button', { name: `${BIG.params[0]!.label.ko} ${ko['recipes.field.choose']}` })
    await user.click(button)
    await user.click(button)
    expect(field(BIG.params[0]!.label.ko).value).toBe('/keep')
  })
})

describe('RecipeForm submit', () => {
  it('stays disabled until the required fields are filled, then enables', async () => {
    const { user } = setup(BIG)
    expect(submit().disabled).toBe(true)
    await fillBig(user)
    expect(submit().disabled).toBe(false)
  })

  it('stays disabled while a field of only spaces is the only content of a required field', async () => {
    const { user } = setup(BIG)
    await fillBig(user)
    await user.clear(field(BIG.params[0]!.label.ko))
    await user.type(field(BIG.params[0]!.label.ko), '   ')
    expect(submit().disabled).toBe(true)
  })

  it('calls onSubmit with typed values: numbers as numbers, defaults left to the server', async () => {
    const onSubmit = vi.fn<(values: RecipeValues) => void>()
    const { user } = setup(BIG, { onSubmit })
    await fillBig(user)
    await user.click(submit())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ watchFolder: '/Users/demo/Receipts', glob: '*.pdf', csvFile: '/Users/demo/ledger.csv', threshold: 250, slackConnection: 'slack-ops' })
    expect(typeof onSubmit.mock.calls[0]![0].threshold).toBe('number')
  })

  it('shows a client error at the field and does not submit', async () => {
    const onSubmit = vi.fn()
    const { user } = setup(BIG, { onSubmit })
    await fillBig(user)
    const number = field(BIG.params[3]!.label.ko)
    await user.clear(number)
    await user.type(number, 'abc')
    await user.click(submit())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(ko['recipes.error.not_a_number'])).toBeTruthy()
    expect(number.getAttribute('aria-invalid')).toBe('true')
    await user.clear(number)
    await user.type(number, '-5')
    await user.click(submit())
    expect(screen.getByText(ko['recipes.rule.below_min'])).toBeTruthy()
  })

  it('clears the error of a field when it is edited', async () => {
    const { user } = setup(BIG)
    await fillBig(user)
    const number = field(BIG.params[3]!.label.ko)
    await user.clear(number)
    await user.type(number, 'abc')
    await user.click(submit())
    await user.type(number, '1')
    expect(screen.queryByText(ko['recipes.error.not_a_number'])).toBeNull()
  })

  it('shows a hint at once when text holds {{ or }} and refuses to submit it', async () => {
    const onSubmit = vi.fn()
    const { user } = setup(REMINDER, { onSubmit })
    const message = field(REMINDER.params[1]!.label.ko)
    await user.clear(message)
    fireEvent.change(message, { target: { value: 'hello {{x}} there' } })
    expect(screen.getByText(ko['recipes.rule.template_text'])).toBeTruthy()
    await user.selectOptions(field(REMINDER.params[2]!.label.ko), 'slack-ops')
    await user.click(submit())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables the button and says so while submitting', () => {
    setup(HEALTH, {}, 'ko', { schedule: '0 9 * * 1-5', url: 'https://x.test', slackConnection: 'slack-ops' })
    expect(submit().disabled).toBe(false)
    setup(HEALTH, { submitting: true }, 'ko', { schedule: '0 9 * * 1-5', url: 'https://x.test', slackConnection: 'slack-ops' })
    expect((screen.getByRole('button', { name: ko['recipes.form.submitting'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onBack from the back button', async () => {
    const onBack = vi.fn()
    const { user } = setup(BIG, { onBack })
    await user.click(screen.getByRole('button', { name: ko['recipes.form.back'] }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('RecipeForm server problems', () => {
  it('puts every <param>: <rule> problem at its field with a localized message', () => {
    setup(BIG, { problems: recipeProblemSets.folderAndFile }, 'ko', initialValues(BIG.params))
    const folder = field(BIG.params[0]!.label.ko)
    expect(folder.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(ko['recipes.rule.not_absolute_path'])).toBeTruthy()
    expect(screen.getByText(ko['recipes.rule.wrong_extension'])).toBeTruthy()
    expect(screen.queryByRole('list', { name: ko['recipes.form.general'] })).toBeNull()
  })

  it('lists <code> at <pointer> issues in the general list with their codes', () => {
    setup(BIG, { problems: recipeProblemSets.pathIssues })
    const list = screen.getByRole('list', { name: ko['recipes.form.general'] })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain(ko['recipes.issue.path_outside_roots'])
    expect(items[0]!.textContent).toContain('path_outside_roots')
    expect(items[0]!.textContent).toContain('/nodes/2/config/file')
    expect(items[1]!.textContent).toContain(ko['recipes.issue.inside_watched_folder'])
  })

  it('shows the generic message and the raw rule id for a rule it does not know', () => {
    setup(BIG, { problems: ['watchFolder: a_rule_from_the_future', 'ghost: required'] })
    expect(screen.getByText(ko['recipes.rule.generic'])).toBeTruthy()
    expect(screen.getByText(t('recipes.field.rawRule', { rule: 'a_rule_from_the_future' }))).toBeTruthy()
    const items = within(screen.getByRole('list', { name: ko['recipes.form.general'] })).getAllByRole('listitem')
    expect(items[0]!.textContent).toContain('ghost')
  })

  it('keeps the typed values and hides a problem of a field that is edited afterwards', async () => {
    const { user } = setup(BIG, { problems: ['watchFolder: not_absolute_path'] }, 'ko', { ...initialValues(BIG.params), watchFolder: 'relative/path' })
    const folder = field(BIG.params[0]!.label.ko)
    expect(folder.value).toBe('relative/path')
    await user.type(folder, 'x')
    expect(screen.queryByText(ko['recipes.rule.not_absolute_path'])).toBeNull()
    expect(folder.value).toBe('relative/pathx')
  })

  it('shows a failure notice that is not about a value, such as an unknown recipe', () => {
    setup(BIG, { failureKey: 'recipes.error.notFound' })
    expect(screen.getByRole('alert').textContent).toContain(ko['recipes.error.notFound'])
  })

  it('shows the same in English', () => {
    setup(BIG, { problems: ['watchFolder: not_absolute_path', 'unknown_connection at /nodes/4/config/connection'] }, 'en')
    expect(screen.getByText(en['recipes.rule.not_absolute_path'])).toBeTruthy()
    expect(screen.getByText(en['recipes.issue.unknown_connection'])).toBeTruthy()
  })
})

describe('RecipeForm hostile text and accessibility', () => {
  it('renders hostile labels and help from the server as text', () => {
    const { view } = setup(hostileRecipes[0]!)
    expect(view.container.querySelector('a, img, script, svg[onload]')).toBeNull()
    expect(view.container.textContent).toContain('<svg onload=alert(1)>')
  })

  it('has no axe violations in the empty, problem and hostile states', async () => {
    const empty = setup(BIG)
    expect(await violations(empty.view.container)).toEqual([])
    empty.view.unmount()
    const problems = setup(BIG, { problems: [...recipeProblemSets.folderAndFile, ...recipeProblemSets.connectionIssues] })
    expect(await violations(problems.view.container)).toEqual([])
    problems.view.unmount()
    const hostile = setup(hostileRecipes[0]!)
    expect(await violations(hostile.view.container)).toEqual([])
  })
})
