import type { RecipeInfo, RecipeValues } from '@rill/protocol'
import { act, fireEvent, screen, within } from '@testing-library/react'
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
const SHEET = recipe('receipt-folder-to-google-sheet')
const EXCEL = recipe('receipt-folder-to-excel')
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

describe('RecipeForm picker timing', () => {
  const folderChoose = () => screen.getByRole('button', { name: `${BIG.params[0]!.label.ko} ${ko['recipes.field.choose']}` })

  function slowPicker() {
    let release: (value: string | undefined) => void = () => undefined
    const onPickPath = vi.fn(() => new Promise<string | undefined>((resolve) => (release = resolve)))
    return { onPickPath, release: (value: string | undefined) => act(async () => release(value)) }
  }

  it('keeps what was typed in other fields while the picker was open', async () => {
    const { onPickPath, release } = slowPicker()
    const { user } = setup(BIG, { onPickPath })
    await user.click(folderChoose())
    await user.type(field(BIG.params[2]!.label.ko), '/Users/demo/out.csv')
    await release('/Users/demo/in')
    expect(field(BIG.params[0]!.label.ko).value).toBe('/Users/demo/in')
    expect(field(BIG.params[2]!.label.ko).value).toBe('/Users/demo/out.csv')
  })

  it('applies two picks that finish in any order to their own fields', async () => {
    const releases: Array<(value: string) => void> = []
    const onPickPath = vi.fn(() => new Promise<string | undefined>((resolve) => releases.push(resolve)))
    const { user } = setup(BIG, { onPickPath })
    await user.click(folderChoose())
    await user.click(screen.getByRole('button', { name: `${BIG.params[2]!.label.ko} ${ko['recipes.field.choose']}` }))
    await act(async () => releases[1]!('/Users/demo/b.csv'))
    await act(async () => releases[0]!('/Users/demo/a'))
    expect(field(BIG.params[0]!.label.ko).value).toBe('/Users/demo/a')
    expect(field(BIG.params[2]!.label.ko).value).toBe('/Users/demo/b.csv')
  })

  it('ignores a pick that finishes after the form is gone', async () => {
    const { onPickPath, release } = slowPicker()
    const onValuesChange = vi.fn()
    const { user, view } = setup(BIG, { onPickPath, onValuesChange })
    await user.click(folderChoose())
    view.unmount()
    await release('/Users/demo/in')
    expect(onValuesChange).not.toHaveBeenCalled()
  })
})

describe('RecipeForm connection that is no longer offered', () => {
  it('shows no selection, counts the field as missing and offers the rest again', async () => {
    const view = renderThemed(<Harness info={BIG} />)
    const user = userEvent.setup()
    await fillBig(user)
    expect(submit().disabled).toBe(false)
    view.rerender(<Harness info={BIG} connections={[{ name: 'slack-dev', kind: 'slack' }]} />)
    expect(field(BIG.params[4]!.label.ko).value).toBe('')
    expect(submit().disabled).toBe(true)
    await user.selectOptions(field(BIG.params[4]!.label.ko), 'slack-dev')
    expect(submit().disabled).toBe(false)
  })

  it('does not submit a name the person cannot see', async () => {
    const onSubmit = vi.fn()
    const { user } = setup(BIG, { onSubmit }, 'ko', { ...initialValues(BIG.params), watchFolder: '/Users/demo/Receipts', csvFile: '/Users/demo/ledger.csv', threshold: '250', slackConnection: 'slack-ghost' })
    expect(field(BIG.params[4]!.label.ko).value).toBe('')
    expect(submit().disabled).toBe(true)
    fireEvent.submit(submit().closest('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(ko['recipes.rule.required'])).toBeTruthy()
    await user.selectOptions(field(BIG.params[4]!.label.ko), 'slack-ops')
    fireEvent.submit(submit().closest('form')!)
    expect(onSubmit).toHaveBeenCalledTimes(1)
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

  it('shows the hint for a closing }} on its own, but not at a number field', () => {
    setup(REMINDER)
    const message = field(REMINDER.params[1]!.label.ko)
    fireEvent.change(message, { target: { value: 'only }} here' } })
    expect(screen.getByText(ko['recipes.rule.template_text'])).toBeTruthy()
    fireEvent.change(message, { target: { value: 'fine' } })
    expect(screen.queryByText(ko['recipes.rule.template_text'])).toBeNull()
  })

  it('shows no template hint at a number field while typing, only the number error on submit', async () => {
    const { user } = setup(BIG)
    await fillBig(user)
    const number = field(BIG.params[3]!.label.ko)
    fireEvent.change(number, { target: { value: '{{1}}' } })
    expect(screen.queryByText(ko['recipes.rule.template_text'])).toBeNull()
    await user.click(submit())
    expect(screen.getByText(ko['recipes.error.not_a_number'])).toBeTruthy()
  })

  it('does not call onSubmit for a form submitted while it is already submitting', () => {
    const onSubmit = vi.fn()
    setup(HEALTH, { submitting: true, onSubmit }, 'ko', { schedule: '0 9 * * 1-5', url: 'https://x.test', slackConnection: 'slack-ops' })
    fireEvent.submit(screen.getByRole('button', { name: ko['recipes.form.submitting'] }).closest('form')!)
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


describe('RecipeForm accounts', () => {
  const GOOGLE_OK: HostConnection = { name: 'google', kind: 'google', account: 'someone@example.com' }
  const GOOGLE_AGAIN: HostConnection = { name: 'google', kind: 'google', account: 'someone@example.com', reconnect: true }
  const MICROSOFT_OK: HostConnection = { name: 'microsoft', kind: 'microsoft', account: 'Alex Doe' }
  const googleField = () => field(SHEET.params[2]!.label.en) as HTMLSelectElement
  const optionsOf = (select: HTMLSelectElement) => [...select.options].map((option) => ({ value: option.value, text: option.textContent, disabled: option.disabled }))

  async function fillSheet(user: ReturnType<typeof userEvent.setup>) {
    await user.type(field(SHEET.params[0]!.label.en), '/Users/demo/Receipts')
    await user.selectOptions(googleField(), 'google')
    await user.type(field(SHEET.params[3]!.label.en), '1DemoSpreadsheetIdForRecipes0')
  }

  it('lists the connected account of the right provider with its account text, and nothing that is saved', () => {
    setup(SHEET, { connections: [...CONNECTIONS, GOOGLE_OK, MICROSOFT_OK] }, 'en')
    expect(optionsOf(googleField())).toEqual([
      { value: '', text: en['recipes.field.connectionPick'], disabled: false },
      { value: 'google', text: 'Google (someone@example.com)', disabled: false },
    ])
  })

  it('lists the Microsoft account for the Excel recipe and not the Google one', () => {
    setup(EXCEL, { connections: [...CONNECTIONS, GOOGLE_OK, MICROSOFT_OK] }, 'en')
    expect(optionsOf(field(EXCEL.params[2]!.label.en) as HTMLSelectElement).map((option) => option.value)).toEqual(['', 'microsoft'])
  })

  it('names the account by its provider alone when the host gave no account text', () => {
    setup(SHEET, { connections: [{ name: 'google', kind: 'google' }] }, 'en')
    expect(optionsOf(googleField()).map((option) => option.text)).toEqual([en['recipes.field.connectionPick'], 'Google'])
  })

  it('submits the name of the account, and the name only', async () => {
    const onSubmit = vi.fn()
    const { user } = setup(SHEET, { connections: [GOOGLE_OK], onSubmit }, 'en')
    await fillSheet(user)
    await user.click(screen.getByRole('button', { name: en['recipes.form.submit'] }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ watchFolder: '/Users/demo/Receipts', glob: '*.pdf', googleConnection: 'google', spreadsheetId: '1DemoSpreadsheetIdForRecipes0' })
    expect(JSON.stringify(onSubmit.mock.calls)).not.toContain('someone@example.com')
  })

  it('submits the Microsoft account with the workbook path and the table', async () => {
    const onSubmit = vi.fn()
    const { user } = setup(EXCEL, { connections: [MICROSOFT_OK], onSubmit }, 'en')
    await user.type(field(EXCEL.params[0]!.label.en), '/Users/demo/Receipts')
    await user.selectOptions(field(EXCEL.params[2]!.label.en), 'microsoft')
    await user.type(field(EXCEL.params[3]!.label.en), 'Receipts/ledger.xlsx')
    await user.type(field(EXCEL.params[4]!.label.en), 'Expenses')
    await user.click(screen.getByRole('button', { name: en['recipes.form.submit'] }))
    expect(onSubmit).toHaveBeenCalledWith({ watchFolder: '/Users/demo/Receipts', glob: '*.pdf', microsoftConnection: 'microsoft', workbookPath: 'Receipts/ledger.xlsx', tableName: 'Expenses' })
  })

  it('shows an account that needs to be connected again, cannot choose it, and says why', async () => {
    const { user } = setup(SHEET, { connections: [GOOGLE_AGAIN] }, 'en')
    expect(optionsOf(googleField())).toEqual([
      { value: '', text: en['recipes.field.connectionPick'], disabled: false },
      { value: 'google', text: 'Google (someone@example.com), needs to be connected again', disabled: true },
    ])
    expect(screen.getByText('The Google account needs to be connected again. Do it in Settings, Connections.')).toBeTruthy()
    await user.selectOptions(googleField(), 'google').catch(() => undefined)
    expect(googleField().value).toBe('')
    await user.type(field(SHEET.params[0]!.label.en), '/Users/demo/Receipts')
    await user.type(field(SHEET.params[3]!.label.en), '1DemoSpreadsheetIdForRecipes0')
    expect((screen.getByRole('button', { name: en['recipes.form.submit'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says it in Korean too', () => {
    setup(SHEET, { connections: [GOOGLE_AGAIN] }, 'ko')
    expect(screen.getByText(t('recipes.field.accountReconnectNote', { kind: ko['recipes.kind.google'] }))).toBeTruthy()
    const select = screen.getByLabelText(SHEET.params[2]!.label.ko) as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([ko['recipes.field.connectionPick'], 'Google (someone@example.com), 다시 연결 필요'])
  })

  it('points to Settings, Connections when no account is connected, and offers no free text', () => {
    setup(SHEET, { connections: CONNECTIONS }, 'en')
    expect(screen.getByText('No Google account is connected. Connect it in Settings, Connections first.')).toBeTruthy()
    expect(screen.queryByLabelText(SHEET.params[2]!.label.en)).toBeNull()
    expect((screen.getByRole('button', { name: en['recipes.form.submit'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says it in Korean and names the provider of the recipe', () => {
    setup(EXCEL, { connections: [GOOGLE_OK] }, 'ko')
    expect(screen.getByText(t('recipes.field.noAccount', { kind: ko['recipes.kind.microsoft'] }))).toBeTruthy()
    expect(ko['recipes.field.noAccount']).toContain('연결')
    expect(screen.queryByText(t('recipes.field.noConnection', { kind: ko['recipes.kind.microsoft'] }))).toBeNull()
  })

  it('keeps the hint of a Slack connection for a Slack parameter', () => {
    setup(BIG, { connections: [GOOGLE_OK] }, 'en')
    expect(screen.getByText(en['recipes.field.noConnection'].replace('{kind}', en['recipes.kind.slack']))).toBeTruthy()
    expect(screen.queryByText(/Settings, Connections/)).toBeNull()
  })

  it('never offers an account for a Slack parameter, nor a Slack connection for an account parameter', () => {
    setup(BIG, { connections: [...CONNECTIONS, GOOGLE_OK, MICROSOFT_OK, GOOGLE_AGAIN] })
    expect([...(field(BIG.params[4]!.label.ko) as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'slack-ops', 'slack-dev'])
    setup(SHEET, { connections: CONNECTIONS, ...{} }, 'en')
    expect(screen.queryByLabelText(SHEET.params[2]!.label.en)).toBeNull()
  })

  it('does not offer a saved connection that carries the name of an account', () => {
    setup(SHEET, { connections: [{ name: 'google', kind: 'slack' }, { name: 'microsoft', kind: 'http' }] }, 'en')
    expect(screen.queryByLabelText(SHEET.params[2]!.label.en)).toBeNull()
    expect(screen.getByText('No Google account is connected. Connect it in Settings, Connections first.')).toBeTruthy()
  })

  it('shows no choice while a chosen account needs to be connected again, and takes the choice back once it is connected', async () => {
    function Live({ connections }: { connections: HostConnection[] }) {
      const [values, setValues] = useState<FormValues>({ ...initialValues(SHEET.params), watchFolder: '/Users/demo/Receipts', googleConnection: 'google', spreadsheetId: '1DemoSpreadsheetIdForRecipes0' })
      return <RecipeForm recipe={SHEET} values={values} onValuesChange={setValues} connections={connections} onSubmit={vi.fn()} onBack={vi.fn()} />
    }
    const view = renderThemed(<Live connections={[GOOGLE_OK]} />, { locale: 'en' })
    const submitButton = () => screen.getByRole('button', { name: en['recipes.form.submit'] }) as HTMLButtonElement
    expect(googleField().value).toBe('google')
    expect(submitButton().disabled).toBe(false)
    view.rerender(<Live connections={[GOOGLE_AGAIN]} />)
    expect(googleField().value).toBe('')
    expect(submitButton().disabled).toBe(true)
    view.rerender(<Live connections={[GOOGLE_OK]} />)
    expect(googleField().value).toBe('google')
    expect(submitButton().disabled).toBe(false)
  })

  it('shows the account text as text, also when it holds markup', () => {
    const hostile = '<img src=x onerror=window.__pwned=1> ‮'
    const view = setup(SHEET, { connections: [{ name: 'google', kind: 'google', account: hostile }] }, 'en').view
    expect(view.container.querySelector('img')).toBeNull()
    expect(optionsOf(googleField())[1]!.text).toBe(`Google (${hostile})`)
  })

  it('has no axe violation with a connected account, an account to connect again and no account', async () => {
    for (const connections of [[GOOGLE_OK], [GOOGLE_AGAIN], CONNECTIONS]) {
      const { view } = setup(SHEET, { connections }, 'en')
      expect(await violations(view.container)).toEqual([])
      view.unmount()
    }
  })
})

describe('RecipeForm spreadsheet fields', () => {
  it('shows a text input with the label and the help for the id, the workbook path and the table', () => {
    setup(SHEET, { connections: [{ name: 'google', kind: 'google' }] }, 'en')
    const id = field(SHEET.params[3]!.label.en)
    expect(id.tagName).toBe('INPUT')
    expect(screen.getByText(SHEET.params[3]!.help!.en)).toBeTruthy()
    setup(EXCEL, { connections: [{ name: 'microsoft', kind: 'microsoft' }] }, 'en')
    for (const param of EXCEL.params.slice(3)) {
      expect((screen.getAllByLabelText(param.label.en).at(-1) as HTMLElement).tagName, param.id).toBe('INPUT')
      expect(screen.getAllByText(param.help!.en).length, param.id).toBeGreaterThan(0)
    }
  })

  it('puts the localized message of each new rule at its field', () => {
    const cases = [
      [SHEET, 'spreadsheetId', 'bad_spreadsheet_id'],
      [EXCEL, 'workbookPath', 'bad_drive_file'],
      [EXCEL, 'tableName', 'bad_table_name'],
    ] as const
    for (const [info, id, rule] of cases) {
      for (const locale of ['ko', 'en'] as const) {
        const dictionary = locale === 'ko' ? ko : en
        const view = renderThemed(
          <RecipeForm recipe={info} values={initialValues(info.params)} onValuesChange={vi.fn()} connections={[]} onSubmit={vi.fn()} onBack={vi.fn()} problems={[`${id}: ${rule}`]} />,
          { locale },
        )
        expect(screen.getByText(dictionary[`recipes.rule.${rule}`]), `${id} ${locale}`).toBeTruthy()
        expect(screen.queryByText(dictionary['recipes.rule.generic'])).toBeNull()
        view.unmount()
      }
    }
  })

  it('refuses a template in the new fields before it is sent', async () => {
    const { user } = setup(EXCEL, { connections: [{ name: 'microsoft', kind: 'microsoft' }] }, 'en')
    await user.type(field(EXCEL.params[3]!.label.en), 'a/{{n1.output.name}}.xlsx')
    expect(screen.getByText(en['recipes.rule.template_text'])).toBeTruthy()
  })
})
