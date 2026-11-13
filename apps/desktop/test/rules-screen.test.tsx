import { RULE_MAX_ITEMS, RillError, type MethodName, type MethodParams, type MethodResult, type Rule } from '@rill/protocol'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RulesScreen } from '../src/app/agents/RulesScreen'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods } from '../src/engine/fake-plan'
import type { RuleViolationScript } from '../src/engine/fake-rules'
import type { RuleViolation } from '../src/model/rules'
import { catalog, fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'
import { createTranslator, type Locale } from '../src/i18n'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'
import { violations as axeViolations } from './axe'
import { renderThemed } from './render'

interface Options {
  rules?: readonly Rule[]
  violations?: RuleViolationScript
  intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined
  locale?: Locale
}

function world(options: Options = {}) {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.violations === undefined ? {} : { violations: options.violations }),
  })
  const calls: Array<{ method: MethodName; params: unknown }> = []
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      return (options.intercept?.(method, params) ?? inner.request(method, params)) as Promise<MethodResult<M>>
    },
    onEvent: inner.onEvent,
  }
  const callsOf = (method: MethodName) => calls.filter((call) => call.method === method).map((call) => call.params)
  return { client, inner, calls, callsOf }
}

function mount(options: Options = {}) {
  const made = world(options)
  const locale = options.locale ?? 'en'
  const view = renderThemed(<RulesScreen client={made.client} catalog={catalog} />, { locale })
  return { ...made, view, user: userEvent.setup(), t: createTranslator(locale) }
}

function rule(id: string, kind: Rule['kind'], value: string, createdAt = 1): Rule {
  return { id, kind, value, createdAt }
}

const group = (name: string): HTMLElement => screen.getByRole('region', { name })
const forbidden = (): HTMLElement => group('Forbidden nodes')
const hosts = (): HTMLElement => group('Allowed hosts')
const cap = (): HTMLElement => group('Planning effort cap')
const existing = (): HTMLElement => group('Existing workflows')
const hostField = (): HTMLInputElement => within(hosts()).getByRole('textbox', { name: 'Host' }) as HTMLInputElement
const nodeSelect = (): HTMLSelectElement => within(forbidden()).getByRole('combobox', { name: 'Node type' }) as HTMLSelectElement
const capSelect = (): HTMLSelectElement => within(cap()).getByRole('combobox', { name: 'Highest effort' }) as HTMLSelectElement

async function ready(): Promise<void> {
  await screen.findByRole('region', { name: 'Forbidden nodes' })
}

function typeHost(value: string): void {
  fireEvent.change(hostField(), { target: { value } })
}

const NODE_RULE = rule('r-node', 'forbidNode', 'http.request')
const HOST_RULE = rule('r-host', 'allowHost', 'api.example.com')
const CAP_RULE = rule('r-cap', 'maxPlanEffort', 'high')

describe('loading', () => {
  it('says so while the rules load, and shows no group yet', () => {
    mount({ intercept: (method) => (method === 'listRules' ? new Promise(() => undefined) : undefined) })
    expect(screen.getByRole('status').textContent).toBe('Loading rules…')
    expect(screen.queryByRole('region', { name: 'Forbidden nodes' })).toBeNull()
  })

  it('shows an alert and a retry when the rules cannot be loaded, and loads again on retry', async () => {
    let fail = true
    const { user, callsOf } = mount({ intercept: (method) => (method === 'listRules' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load the rules.')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await ready()
    expect(callsOf('listRules')).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the page', () => {
  it('has the title, says that rules only restrict and apply to everything, and says that removing one allows more', async () => {
    mount()
    await ready()
    expect(screen.getByRole('heading', { level: 2, name: 'Rules' })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).toContain('A rule only restricts')
    expect(text).toContain('every agent and to everything that is deployed, activated or run')
    expect(text).toContain('removing a rule allows more again')
  })

  it('says in a muted line that the forbidden nodes and the allowed hosts are told to the model', async () => {
    mount()
    await ready()
    expect(screen.getByText(/also told to the model, so that it can avoid them/)).toBeTruthy()
    expect(document.querySelector('svg')).toBeNull()
  })

  it('has the four groups, each as a region with a heading of level 3', async () => {
    mount()
    await ready()
    for (const name of ['Forbidden nodes', 'Allowed hosts', 'Planning effort cap', 'Existing workflows']) {
      expect(within(group(name)).getByRole('heading', { level: 3, name })).toBeTruthy()
    }
  })

  it('counts the rules out of 30', async () => {
    mount({ rules: [NODE_RULE, HOST_RULE, CAP_RULE] })
    await ready()
    expect(screen.getByText('3 of 30 rules')).toBeTruthy()
  })

  it('speaks Korean', async () => {
    mount({ locale: 'ko' })
    await screen.findByRole('region', { name: ko['rules.forbid.title'] })
    expect(screen.getByRole('heading', { level: 2, name: ko['rules.screen.title'] })).toBeTruthy()
    expect(screen.getByRole('region', { name: ko['rules.hosts.title'] })).toBeTruthy()
    expect(screen.getByRole('region', { name: ko['rules.cap.title'] })).toBeTruthy()
    expect(screen.getByRole('region', { name: ko['rules.check.title'] })).toBeTruthy()
    expect(screen.getByText(ko['rules.hosts.empty'])).toBeTruthy()
  })
})

describe('forbidden nodes', () => {
  it('offers every node type of the catalog once, with its title, and no version', async () => {
    mount()
    await ready()
    const options = within(nodeSelect()).getAllByRole('option').map((option) => option.textContent)
    expect(options[0]).toBe('Choose a node type')
    expect(options).toContain('HTTP request (http.request)')
    expect(options).toContain('Folder watch (trigger.folderWatch)')
    expect(options).toContain('Slack message (notify.slack)')
    expect(options.some((option) => option?.includes('@'))).toBe(false)
    expect(options).toHaveLength(1 + new Set(catalog.map((entry) => entry.type.replace(/@\d+$/, ''))).size)
  })

  it('has the Add button off until a type is chosen, and says nothing is forbidden', async () => {
    mount()
    await ready()
    expect((within(forbidden()).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(forbidden()).getByText('No node type is forbidden.')).toBeTruthy()
    expect(within(forbidden()).queryByRole('list', { name: 'Forbidden node types' })).toBeNull()
  })

  it('adds the chosen type once, lists it, takes it out of the select and says so', async () => {
    const { user, callsOf } = mount()
    await ready()
    await user.selectOptions(nodeSelect(), 'http.request')
    await user.click(within(forbidden()).getByRole('button', { name: 'Add' }))
    const list = await within(forbidden()).findByRole('list', { name: 'Forbidden node types' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['HTTP request (http.request)Remove'])
    expect(callsOf('saveRule')).toEqual([{ kind: 'forbidNode', value: 'http.request' }])
    expect(within(nodeSelect()).queryByRole('option', { name: /http\.request/ })).toBeNull()
    expect(nodeSelect().value).toBe('')
    expect(within(forbidden()).getByRole('status').textContent).toBe('The rule was added.')
    expect(within(forbidden()).queryByText('No node type is forbidden.')).toBeNull()
  })

  it('puts the focus back on the select after an add', async () => {
    const { user } = mount()
    await ready()
    await user.selectOptions(nodeSelect(), 'delay')
    await user.click(within(forbidden()).getByRole('button', { name: 'Add' }))
    await within(forbidden()).findByRole('list', { name: 'Forbidden node types' })
    expect(document.activeElement).toBe(nodeSelect())
  })

  it('lists the saved rules oldest first, one row each, with a Remove button that names the node', async () => {
    mount({ rules: [rule('a', 'forbidNode', 'delay', 1), rule('b', 'forbidNode', 'notify.slack', 2)] })
    await ready()
    const rows = within(within(forbidden()).getByRole('list', { name: 'Forbidden node types' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['Delay (delay)Remove', 'Slack message (notify.slack)Remove'])
    expect(within(forbidden()).getByRole('button', { name: 'Remove Delay (delay) from the forbidden nodes' })).toBeTruthy()
  })

  it('shows a rule for a type that the catalog does not know by its code', async () => {
    mount({ rules: [rule('a', 'forbidNode', 'old.node')] })
    await ready()
    expect(within(forbidden()).getByText('old.node')).toBeTruthy()
  })

  it('says that every type is forbidden when none is left to pick', async () => {
    const all = [...new Set(catalog.map((entry) => entry.type.replace(/@\d+$/, '')))].slice(0, 14).map((type, index) => rule(`n${index}`, 'forbidNode', type, index))
    mount({ rules: all })
    await ready()
    expect(within(forbidden()).getByText('Every node type is already forbidden.')).toBeTruthy()
    expect(nodeSelect().disabled).toBe(true)
  })
})

describe('allowed hosts', () => {
  it('shows the format hint with the field, and says that all hosts are allowed while the list is empty', async () => {
    mount()
    await ready()
    expect(within(hosts()).getByText(/A host name such as api\.example\.com\. \*\.example\.com means every subdomain, but not example\.com itself/)).toBeTruthy()
    expect(within(hosts()).getByText('The list is empty, so all hosts are allowed.')).toBeTruthy()
    expect(within(hosts()).queryByRole('list', { name: 'Allowed hosts' })).toBeNull()
    expect(hostField().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('says that the Slack node is not limited by the list', async () => {
    mount()
    await ready()
    expect(within(hosts()).getByText('The Slack message node is not limited by this list. To stop it, forbid that node.')).toBeTruthy()
  })

  it('has Add off while the field is empty and shows no message for an empty field', async () => {
    mount()
    await ready()
    const add = within(hosts()).getByRole('button', { name: 'Add' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    typeHost('   ')
    expect(add.disabled).toBe(true)
    expect(hostField().getAttribute('aria-invalid')).toBeNull()
  })

  const PROBLEMS: Array<[string, string]> = [
    ['https://api.example.com', 'Write only the host name, without http:// or https://.'],
    ['api.example.com/path', 'Write only the host name, without a path, query or fragment.'],
    ['api.example.com:8443', 'Write only the host name, without a port.'],
    ['me@api.example.com', 'Write only the host name, without a user name.'],
    ['api example.com', 'A host name has no spaces.'],
    ['api..example.com', 'A host name has no empty part between dots, and does not start or end with a dot.'],
    ['*', 'A wildcard is only *. in front of a host name, such as *.example.com. It cannot stand in front of an address.'],
    ['*.127.0.0.1', 'A wildcard is only *. in front of a host name, such as *.example.com. It cannot stand in front of an address.'],
    ['a!b.example.com', 'A host name has letters, digits, hyphens and dots. Write an address in full.'],
    ['x'.repeat(64) + '.com', 'Each part between dots is at most 63 characters.'],
    ['a\u202eb.example.com', 'Characters that change the text direction are not allowed.'],
    ['x'.repeat(501), 'At most 500 characters.'],
  ]

  for (const [text, message] of PROBLEMS) {
    it(`checks as you type: ${JSON.stringify(text.length > 30 ? `${text.slice(0, 30)}...` : text)}`, async () => {
      mount()
      await ready()
      typeHost(text)
      expect(within(hosts()).getByText(message)).toBeTruthy()
      expect(hostField().getAttribute('aria-invalid')).toBe('true')
      expect(hostField().getAttribute('aria-describedby')?.split(' ').some((id) => document.getElementById(id)?.textContent === message)).toBe(true)
      expect((within(hosts()).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    })
  }

  it('never shows the typed value in the message', async () => {
    mount()
    await ready()
    typeHost('https://very-secret.example.com/path')
    expect(within(hosts()).queryByText(/very-secret/)).toBeNull()
  })

  it('accepts a valid host, a wildcard and an address, and clears the message', async () => {
    mount()
    await ready()
    for (const text of ['api.example.com', '*.example.com', '127.0.0.1', '[::1]']) {
      typeHost(text)
      expect(hostField().getAttribute('aria-invalid')).toBeNull()
      expect((within(hosts()).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it('says how a host is saved when that differs from what was typed', async () => {
    mount()
    await ready()
    typeHost('API.Example.COM')
    expect(within(hosts()).getByText('It will be saved as api.example.com.')).toBeTruthy()
    typeHost('münchen.de')
    expect(within(hosts()).getByText('It will be saved as xn--mnchen-3ya.de.')).toBeTruthy()
    typeHost('api.example.com')
    expect(within(hosts()).queryByText(/It will be saved as/)).toBeNull()
  })

  it('refuses a host that is in the list, in another spelling too, before it asks the engine', async () => {
    const { callsOf } = mount({ rules: [HOST_RULE] })
    await ready()
    typeHost('API.example.com')
    expect(within(hosts()).getByText('It is already in the list.')).toBeTruthy()
    expect((within(hosts()).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    expect(callsOf('saveRule')).toEqual([])
  })

  it('adds the host in its saved form, empties the field, keeps the focus there and says so', async () => {
    const { user, callsOf } = mount()
    await ready()
    typeHost('  *.Example.com ')
    await user.click(within(hosts()).getByRole('button', { name: 'Add' }))
    const list = await within(hosts()).findByRole('list', { name: 'Allowed hosts' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['*.example.comRemove'])
    expect(callsOf('saveRule')).toEqual([{ kind: 'allowHost', value: '  *.Example.com ' }])
    expect(hostField().value).toBe('')
    expect(document.activeElement).toBe(hostField())
    expect(within(hosts()).getByRole('status').textContent).toBe('The rule was added.')
    expect(within(hosts()).queryByText('The list is empty, so all hosts are allowed.')).toBeNull()
  })

  it('adds with the Enter key', async () => {
    const { user, callsOf } = mount()
    await ready()
    await user.type(hostField(), 'api.example.com{Enter}')
    await within(hosts()).findByRole('list', { name: 'Allowed hosts' })
    expect(callsOf('saveRule')).toHaveLength(1)
  })

  it('sends one request when the form is submitted twice at once', async () => {
    const { callsOf } = mount()
    await ready()
    typeHost('api.example.com')
    const form = hostField().closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    await within(hosts()).findByRole('list', { name: 'Allowed hosts' })
    expect(callsOf('saveRule')).toHaveLength(1)
  })

  it('sends one request when the node form is submitted twice at once', async () => {
    const { user, callsOf } = mount()
    await ready()
    await user.selectOptions(nodeSelect(), 'delay')
    const form = nodeSelect().closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    await within(forbidden()).findByRole('list', { name: 'Forbidden node types' })
    expect(callsOf('saveRule')).toHaveLength(1)
  })

  it('does not send a host with a problem even when the form is submitted', async () => {
    const { callsOf } = mount()
    await ready()
    typeHost('https://api.example.com')
    fireEvent.submit(hostField().closest('form')!)
    expect(callsOf('saveRule')).toEqual([])
  })

  it('shows the host rules as plain text, as saved', async () => {
    mount({ rules: [rule('a', 'allowHost', 'xn--mnchen-3ya.de'), rule('b', 'allowHost', '[::1]'), rule('c', 'allowHost', '*.example.com')] })
    await ready()
    const rows = within(within(hosts()).getByRole('list', { name: 'Allowed hosts' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['xn--mnchen-3ya.deRemove', '[::1]Remove', '*.example.comRemove'])
    expect(within(hosts()).getByRole('button', { name: 'Remove *.example.com from the allowed hosts' })).toBeTruthy()
  })
})

describe('the planning effort cap', () => {
  it('has No cap first, then the five efforts by their names in the chat', async () => {
    mount()
    await ready()
    expect(within(capSelect()).getAllByRole('option').map((option) => option.textContent)).toEqual(['No cap', 'Fast', 'Normal', 'Careful', 'Very careful', 'Maximum'])
    expect(capSelect().value).toBe('none')
  })

  it('shows the cap that is saved', async () => {
    mount({ rules: [CAP_RULE] })
    await ready()
    expect(capSelect().value).toBe('high')
  })

  it('saves a cap as soon as one is chosen, and says so', async () => {
    const { user, callsOf } = mount()
    await ready()
    await user.selectOptions(capSelect(), 'medium')
    await waitFor(() => expect(within(cap()).getByRole('status').textContent).toBe('The highest effort is now Normal.'))
    expect(callsOf('saveRule')).toEqual([{ kind: 'maxPlanEffort', value: 'medium' }])
    expect(capSelect().value).toBe('medium')
  })

  it('replaces the cap when another step is chosen and keeps one cap rule', async () => {
    const { user, callsOf } = mount({ rules: [CAP_RULE] })
    await ready()
    await user.selectOptions(capSelect(), 'low')
    await waitFor(() => expect(capSelect().value).toBe('low'))
    expect(callsOf('saveRule')).toEqual([{ kind: 'maxPlanEffort', value: 'low' }])
    expect(screen.getByText('1 of 30 rules')).toBeTruthy()
  })

  it('asks before the cap is removed, names it, and keeps it when the answer is no', async () => {
    const { user, callsOf } = mount({ rules: [CAP_RULE] })
    await ready()
    await user.selectOptions(capSelect(), 'none')
    const dialog = await screen.findByRole('dialog', { name: 'Remove this rule?' })
    expect(within(dialog).getByText('The cap “Careful” is removed. A plan request may use any step again.')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(capSelect().value).toBe('high')
    expect(callsOf('deleteRule')).toEqual([])
  })

  it('removes the cap after the confirmation', async () => {
    const { user, callsOf } = mount({ rules: [CAP_RULE] })
    await ready()
    await user.selectOptions(capSelect(), 'none')
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove rule' }))
    await waitFor(() => expect(capSelect().value).toBe('none'))
    expect(callsOf('deleteRule')).toEqual([{ id: 'r-cap' }])
    expect(within(cap()).getByRole('status').textContent).toBe('The cap was removed.')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains that a request above the cap is lowered and never refused', async () => {
    mount()
    await ready()
    expect(within(cap()).getByText(/A request above the cap runs at the cap; it is not refused\./)).toBeTruthy()
  })

  it('keeps a value it does not know out of the select instead of crashing', async () => {
    mount({ rules: [rule('r-cap', 'maxPlanEffort', 'ultra')] })
    await ready()
    expect(capSelect().value).toBe('none')
  })
})

describe('removing a rule', () => {
  it('asks first, names a forbidden node, and keeps the rule when the answer is no', async () => {
    const { user, callsOf } = mount({ rules: [NODE_RULE] })
    await ready()
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove this rule?' })
    expect(within(dialog).getByText('The node type “http.request” is no longer forbidden. Plans, recipes and workflows may use it again.')).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep it' }))
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(callsOf('deleteRule')).toEqual([])
    expect(within(forbidden()).getByRole('list', { name: 'Forbidden node types' })).toBeTruthy()
  })

  it('cancels with the Escape key', async () => {
    const { user, callsOf } = mount({ rules: [NODE_RULE] })
    await ready()
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(callsOf('deleteRule')).toEqual([])
  })

  it('removes a forbidden node after the confirmation, puts it back in the select and moves the focus to the group', async () => {
    const { user, callsOf } = mount({ rules: [NODE_RULE] })
    await ready()
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove rule' }))
    await waitFor(() => expect(within(forbidden()).queryByRole('list', { name: 'Forbidden node types' })).toBeNull())
    expect(callsOf('deleteRule')).toEqual([{ id: 'r-node' }])
    expect(within(nodeSelect()).getByRole('option', { name: 'HTTP request (http.request)' })).toBeTruthy()
    expect(within(forbidden()).getByRole('status').textContent).toBe('The rule was removed.')
    expect(document.activeElement).toBe(within(forbidden()).getByRole('heading', { name: 'Forbidden nodes' }))
  })

  it('names the host, and says the list is empty and all hosts are allowed when it was the last one', async () => {
    const { user } = mount({ rules: [HOST_RULE] })
    await ready()
    await user.click(within(hosts()).getByRole('button', { name: /^Remove api\.example\.com/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('The host “api.example.com” is removed from the allowed hosts.')).toBeTruthy()
    expect(within(dialog).getByText('The list will be empty, so all hosts are allowed.')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Remove rule' }))
    await waitFor(() => expect(within(hosts()).getByText('The list is empty, so all hosts are allowed.')).toBeTruthy())
  })

  it('says that requests to the host are refused when other hosts stay in the list', async () => {
    const { user } = mount({ rules: [HOST_RULE, rule('r-2', 'allowHost', 'b.example.com')] })
    await ready()
    await user.click(within(hosts()).getByRole('button', { name: /^Remove api\.example\.com/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Requests to this host are refused unless another rule allows it.')).toBeTruthy()
    expect(within(dialog).queryByText(/all hosts are allowed/)).toBeNull()
  })

  it('stays open with an alert when the engine refuses, and nothing is removed', async () => {
    const { user } = mount({ rules: [NODE_RULE], intercept: (method) => (method === 'deleteRule' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remove rule' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en['rules.error.generic'])
    expect(within(forbidden()).getByRole('list', { name: 'Forbidden node types' })).toBeTruthy()
  })

  it('says the rule was already gone for RULE_NOT_FOUND, closes the dialog and loads the list again', async () => {
    const { user, callsOf } = mount({ rules: [NODE_RULE], intercept: (method) => (method === 'deleteRule' ? Promise.reject(new RillError('RULE_NOT_FOUND', 'x')) : undefined) })
    await ready()
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove rule' }))
    expect((await within(forbidden()).findByRole('alert')).textContent).toBe(en['rules.error.RULE_NOT_FOUND'])
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(callsOf('listRules')).toHaveLength(2))
  })

  it('sends one request when Remove rule is pressed twice', async () => {
    const { callsOf } = mount({ rules: [NODE_RULE] })
    await ready()
    fireEvent.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove rule' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsOf('deleteRule')).toHaveLength(1)
  })
})

describe('the limit of 30 rules', () => {
  const full = Array.from({ length: RULE_MAX_ITEMS }, (_, index) => rule(`h${index}`, 'allowHost', `h${index}.example.com`, index))

  it('says that all places are used and turns every Add off', async () => {
    mount({ rules: full })
    await ready()
    expect(screen.getByText('30 of 30 rules')).toBeTruthy()
    expect(screen.getByText('All 30 places are used. Remove a rule to add another.')).toBeTruthy()
    typeHost('one-more.example.com')
    for (const region of [forbidden(), hosts()]) expect((within(region).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has a note with the role note, and no note below the limit', async () => {
    const { view } = mount({ rules: full })
    await ready()
    expect(screen.getByRole('note').textContent).toBe('All 30 places are used. Remove a rule to add another.')
    view.unmount()
    mount({ rules: full.slice(0, 29) })
    await ready()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('still lets the cap be replaced when a cap exists, and blocks a first cap', async () => {
    const withCap = [CAP_RULE, ...full.slice(0, RULE_MAX_ITEMS - 1)]
    const first = mount({ rules: withCap })
    await ready()
    expect(capSelect().disabled).toBe(false)
    first.view.unmount()
    mount({ rules: full })
    await ready()
    expect(capSelect().disabled).toBe(true)
  })
})

describe('errors of the engine', () => {
  async function addHost(user: ReturnType<typeof userEvent.setup>, code: string, problems: string[] = []) {
    const made = mount({ intercept: (method) => (method === 'saveRule' ? Promise.reject(new RillError(code, 'x', problems)) : undefined) })
    await ready()
    typeHost('api.example.com')
    await user.click(within(hosts()).getByRole('button', { name: 'Add' }))
    return made
  }

  it('says a fixed text for RULE_FULL, with the limit', async () => {
    await addHost(userEvent.setup(), 'RULE_FULL')
    expect((await within(hosts()).findByRole('alert')).textContent).toBe('At most 30 rules can be saved. Remove one first.')
  })

  it('says a fixed text for RULE_DUPLICATE', async () => {
    await addHost(userEvent.setup(), 'RULE_DUPLICATE')
    expect((await within(hosts()).findByRole('alert')).textContent).toBe('The same rule is already saved.')
  })

  it('says the text of the rule problem for RULE_INVALID, and the general text for a problem it does not know', async () => {
    const first = await addHost(userEvent.setup(), 'RULE_INVALID', ['host_port: write only the host name, without a port'])
    expect((await within(hosts()).findByRole('alert')).textContent).toBe('Write only the host name, without a port.')
    first.view.unmount()
    await addHost(userEvent.setup(), 'RULE_INVALID', ['something_new: x'])
    expect((await within(hosts()).findByRole('alert')).textContent).toBe('This rule is not valid, so it was not saved.')
  })

  it('says a general text for any other error and keeps what was typed', async () => {
    await addHost(userEvent.setup(), 'INTERNAL')
    expect((await within(hosts()).findByRole('alert')).textContent).toBe(en['rules.error.generic'])
    expect(hostField().value).toBe('api.example.com')
  })

  it('shows the error in the group where it happened and not in the others', async () => {
    await addHost(userEvent.setup(), 'RULE_DUPLICATE')
    await within(hosts()).findByRole('alert')
    expect(within(forbidden()).queryByRole('alert')).toBeNull()
    expect(within(cap()).queryByRole('alert')).toBeNull()
  })

  it('takes the error away when the field is edited', async () => {
    await addHost(userEvent.setup(), 'INTERNAL')
    await within(hosts()).findByRole('alert')
    typeHost('other.example.com')
    expect(within(hosts()).queryByRole('alert')).toBeNull()
  })

  it('says a fixed text for a cap that could not be saved and keeps the old cap', async () => {
    const user = userEvent.setup()
    mount({ rules: [CAP_RULE], intercept: (method) => (method === 'saveRule' ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    await user.selectOptions(capSelect(), 'low')
    expect((await within(cap()).findByRole('alert')).textContent).toBe(en['rules.error.generic'])
    expect(capSelect().value).toBe('high')
  })
})

describe('existing workflows', () => {
  const issue = (message: string, pointer = '/nodes/1/type') => ({ stage: 3 as const, pointer, code: 'rule_violation', message })
  const entry = (workflowId: string, name: string, issues = [issue('node n1: the node type http.request is forbidden by the rules')]): RuleViolation => ({ workflowId, name, issues })

  it('checks once when the screen opens, and says that no workflow breaks a rule', async () => {
    const { callsOf } = mount()
    await ready()
    expect(await within(existing()).findByText('No workflow breaks a rule.')).toBeTruthy()
    expect(callsOf('checkRules')).toHaveLength(1)
    expect(within(existing()).queryByRole('list')).toBeNull()
  })

  it('says it is checking while the answer is on its way', async () => {
    mount({ intercept: (method) => (method === 'checkRules' ? new Promise(() => undefined) : undefined) })
    await ready()
    expect(within(existing()).getByText('Checking your workflows…')).toBeTruthy()
  })

  it('lists each workflow that breaks a rule with the messages of its issues, as text', async () => {
    mount({ violations: () => [entry('wf-1', 'Receipts to CSV'), entry('wf-2', 'Daily check', [issue('node n2: the host evil.example is not in the allowed hosts', '/nodes/2/config/url'), issue('node n3: the node type delay is forbidden by the rules', '/nodes/3/type')])] })
    await ready()
    const list = await within(existing()).findByRole('list', { name: 'Workflows that break a rule' })
    const rows = within(list).getAllByRole('listitem').filter((row) => row.parentElement === list)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Receipts to CSV')
    expect(rows[0]!.textContent).toContain('node n1: the node type http.request is forbidden by the rules')
    expect(rows[1]!.textContent).toContain('node n2: the host evil.example is not in the allowed hosts')
    expect(rows[1]!.textContent).toContain('node n3: the node type delay is forbidden by the rules')
    expect(within(existing()).getByText('2 workflows break a rule.')).toBeTruthy()
  })

  it('says one workflow in the singular and in Korean', async () => {
    const first = mount({ violations: () => [entry('wf-1', 'One')] })
    await ready()
    expect(await within(existing()).findByText('1 workflow breaks a rule.')).toBeTruthy()
    first.view.unmount()
    mount({ violations: () => [entry('wf-1', 'One')], locale: 'ko' })
    await screen.findByRole('region', { name: ko['rules.check.title'] })
    expect(await screen.findByText('워크플로우 1개가 규칙을 어겨요.')).toBeTruthy()
  })

  it('shows hostile names and messages as plain text, with hidden characters made visible', async () => {
    mount({
      violations: () => [
        entry('wf-1', '<img src=x onerror=alert(1)> \u202egpj\u200b', [issue('<script>alert(2)</script> **bold** [x](https://evil.example)\u202e')]),
      ],
    })
    await ready()
    const list = await within(existing()).findByRole('list', { name: 'Workflows that break a rule' })
    expect(list.querySelector('img, script, a, b')).toBeNull()
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(list.textContent).toContain('‹U+202E›')
    expect(list.textContent).toContain('‹U+200B›')
    expect(list.textContent).not.toMatch(/[\u202e\u200b]/)
  })

  it('cuts a very long name and a very long message', async () => {
    mount({ violations: () => [entry('wf-1', 'N'.repeat(500), [issue('M'.repeat(2000))])] })
    await ready()
    const list = await within(existing()).findByRole('list', { name: 'Workflows that break a rule' })
    expect(list.textContent!.length).toBeLessThan(700)
    expect(list.textContent).toContain('…')
  })

  it('shows the first three issues of a workflow and counts the rest', async () => {
    const many = Array.from({ length: 20 }, (_, index) => issue(`problem number ${index}`, `/nodes/${index}/type`))
    mount({ violations: () => [entry('wf-1', 'Many', many)] })
    await ready()
    const list = await within(existing()).findByRole('list', { name: 'Workflows that break a rule' })
    expect(list.textContent).toContain('problem number 0')
    expect(list.textContent).toContain('problem number 2')
    expect(list.textContent).not.toContain('problem number 3')
    expect(within(list).getByText('…and 17 more problems')).toBeTruthy()
  })

  it('says it could not check, and checks again on the button', async () => {
    let fail = true
    const { user, callsOf } = mount({ intercept: (method) => (method === 'checkRules' && fail ? Promise.reject(new RillError('INTERNAL', 'x')) : undefined) })
    await ready()
    expect((await within(existing()).findByRole('alert')).textContent).toBe('Could not check the workflows.')
    fail = false
    await user.click(within(existing()).getByRole('button', { name: 'Check again' }))
    expect(await within(existing()).findByText('No workflow breaks a rule.')).toBeTruthy()
    expect(callsOf('checkRules')).toHaveLength(2)
  })

  it('checks again after a rule was added or removed, and shows the new answer', async () => {
    const user = userEvent.setup()
    const { callsOf } = mount({ violations: (rules) => (rules.some((item) => item.value === 'delay') ? [entry('wf-9', 'Pauses a lot', [issue('node n3: the node type delay is forbidden by the rules')])] : []) })
    await ready()
    await within(existing()).findByText('No workflow breaks a rule.')
    await user.selectOptions(nodeSelect(), 'delay')
    await user.click(within(forbidden()).getByRole('button', { name: 'Add' }))
    const list = await within(existing()).findByRole('list', { name: 'Workflows that break a rule' })
    expect(list.textContent).toContain('Pauses a lot')
    expect(callsOf('checkRules')).toHaveLength(2)
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove Delay/ }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove rule' }))
    expect(await within(existing()).findByText('No workflow breaks a rule.')).toBeTruthy()
    expect(callsOf('checkRules')).toHaveLength(3)
  })

  it('keeps the newest answer when an older check ends last', async () => {
    const answers: Array<(value: unknown) => void> = []
    const user = userEvent.setup()
    mount({
      intercept: (method) => (method === 'checkRules' ? new Promise((resolve) => answers.push(resolve)) : undefined),
    })
    await ready()
    await waitFor(() => expect(answers).toHaveLength(1))
    await user.click(within(existing()).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(answers).toHaveLength(2))
    answers[1]!({ violations: [] })
    expect(await within(existing()).findByText('No workflow breaks a rule.')).toBeTruthy()
    answers[0]!({ violations: [entry('wf-old', 'Old answer')] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(within(existing()).queryByText('Old answer')).toBeNull()
    expect(within(existing()).getByText('No workflow breaks a rule.')).toBeTruthy()
  })

  it('announces the result in a status region', async () => {
    mount()
    await ready()
    await within(existing()).findByText('No workflow breaks a rule.')
    expect(within(existing()).getByRole('status').textContent).toBe('No workflow breaks a rule.')
  })
})

describe('the sources of the text on the screen', () => {
  it('never put the text of an engine error on the screen', async () => {
    const { user } = mount({ intercept: (method) => (method === 'saveRule' ? Promise.reject(new RillError('RULE_FULL', 'ENGINE-TEXT-MARKER-9921')) : undefined) })
    await ready()
    typeHost('api.example.com')
    await user.click(within(hosts()).getByRole('button', { name: 'Add' }))
    await within(hosts()).findByRole('alert')
    expect(document.body.textContent).not.toContain('ENGINE-TEXT-MARKER-9921')
  })
})

describe('accessibility', () => {
  it('has no axe violation with rules of every kind and a violation listed', async () => {
    mount({ rules: [NODE_RULE, HOST_RULE, CAP_RULE], violations: () => [{ workflowId: 'wf-1', name: 'Receipts', issues: [{ stage: 3, pointer: '/nodes/1/type', code: 'rule_violation', message: 'node n1: the node type http.request is forbidden by the rules' }] }] })
    await ready()
    await within(existing()).findByRole('list', { name: 'Workflows that break a rule' })
    typeHost('https://bad.example.com')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violation while a confirmation is open', async () => {
    const { user } = mount({ rules: [NODE_RULE] })
    await ready()
    await user.click(within(forbidden()).getByRole('button', { name: /^Remove HTTP request/ }))
    await screen.findByRole('dialog')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('names every control by its label', async () => {
    mount({ rules: [NODE_RULE, HOST_RULE, CAP_RULE] })
    await ready()
    for (const button of screen.getAllByRole('button')) expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim(), button.outerHTML).not.toBe('')
    expect(screen.getAllByRole('combobox').map((box) => box.id)).not.toContain('')
  })
})
