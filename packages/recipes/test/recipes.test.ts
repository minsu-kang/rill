import { WorkflowSchema, extractRefs, findMalformedTemplates, isTrigger, stringLeaves, type Workflow } from '@rill/dsl'
import { createCoreRegistry, validateWorkflow } from '@rill/nodes-core'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { PARAM_KINDS, RECIPES, RecipeSchema, findRecipe, instantiateRecipe, recipeNodeTypes, recipeProblems, type ParamValues, type Recipe } from '../src/index'

const registry = createCoreRegistry()
const ENV = { registry, allowedRoots: ['/Users/demo'], connections: ['slack-ops'] }

const EXPECTED_IDS = [
  'receipt-folder-to-csv',
  'receipt-big-amount-alert',
  'daily-health-check',
  'webhook-to-slack',
  'monthly-reminder',
  'failure-webhook-alert',
]

function build(recipe: Recipe, values: ParamValues): Workflow {
  const result = instantiateRecipe(recipe, values)
  if (!('workflow' in result)) throw new Error(`${recipe.id}: ${JSON.stringify(result.problems)}`)
  return result.workflow
}

function requiredOnly(recipe: Recipe): ParamValues {
  return Object.fromEntries(recipe.params.filter((param) => param.required).map((param) => [param.id, recipe.sample[param.id]!]))
}

function codes(workflow: Workflow): string[] {
  return validateWorkflow(workflow, ENV).map((issue) => `${issue.code} at ${issue.pointer}`)
}

function everyText(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(everyText)
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => [key, ...everyText(inner)])
  return []
}

function leaves(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leaves)
  return [value]
}

describe('the catalogue', () => {
  it('holds the six recipes of the plan, in this order', () => {
    expect(RECIPES.map((recipe) => recipe.id)).toEqual(EXPECTED_IDS)
  })

  it('has unique ids', () => {
    expect(new Set(RECIPES.map((recipe) => recipe.id)).size).toBe(RECIPES.length)
  })

  it('finds a recipe by its exact id and nothing else', () => {
    for (const recipe of RECIPES) expect(findRecipe(recipe.id)).toBe(recipe)
    for (const id of ['', 'nope', 'Receipt-Folder-To-Csv', 'receipt-folder-to-csv ', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(findRecipe(id), id).toBeUndefined()
    }
  })
})

describe.each(RECIPES)('the recipe $id', (recipe) => {
  it('is well written: the shape, the parameters, the sample and every placeholder', () => {
    expect(Value.Check(RecipeSchema, recipe)).toBe(true)
    expect(recipeProblems(recipe)).toEqual([])
  })

  it('names a Korean and an English title, description and label for every parameter', () => {
    const texts = [recipe.title, recipe.description, ...recipe.params.flatMap((param) => [param.label, param.help ?? recipe.title])]
    for (const text of texts) {
      expect(text.ko.trim()).not.toBe('')
      expect(text.en.trim()).not.toBe('')
      expect(/[가-힣]/.test(text.ko)).toBe(true)
      expect(/[가-힣]/.test(text.en)).toBe(false)
    }
  })

  it('declares only known parameter kinds, each parameter once', () => {
    for (const param of recipe.params) expect(PARAM_KINDS as readonly string[]).toContain(param.kind)
    expect(new Set(recipe.params.map((param) => param.id)).size).toBe(recipe.params.length)
  })

  it('has a sample value for every parameter, and an optional one differs from its default', () => {
    expect(Object.keys(recipe.sample).sort()).toEqual(recipe.params.map((param) => param.id).sort())
    for (const param of recipe.params.filter((entry) => !entry.required)) expect(recipe.sample[param.id], param.id).not.toBe(param.default)
  })

  it('uses node types that the core registry has', () => {
    for (const type of recipeNodeTypes(recipe)) expect(registry.has(type), type).toBe(true)
  })

  it('lists its node types the way the instantiated workflow has them', () => {
    const workflow = build(recipe, recipe.sample)
    expect(recipeNodeTypes(recipe)).toEqual([...new Set(workflow.nodes.map((node) => node.type))])
  })

  it('instantiates with its sample into a workflow that passes the three stages of validateWorkflow with no issue and no warning', () => {
    const workflow = build(recipe, recipe.sample)
    expect(Value.Check(WorkflowSchema, workflow)).toBe(true)
    expect(codes(workflow)).toEqual([])
  })

  it('instantiates with the required values alone, the defaults filling the rest, into a valid workflow', () => {
    const workflow = build(recipe, requiredOnly(recipe))
    expect(codes(workflow)).toEqual([])
  })

  it('carries every sample value into the workflow, and every default when the value is left out', () => {
    const withSample = leaves(build(recipe, recipe.sample))
    for (const param of recipe.params) expect(withSample, param.id).toContain(recipe.sample[param.id])
    const withDefaults = leaves(build(recipe, requiredOnly(recipe)))
    for (const param of recipe.params.filter((entry) => !entry.required)) expect(withDefaults, param.id).toContain(param.default)
  })

  it('leaves no placeholder behind', () => {
    expect(JSON.stringify(build(recipe, recipe.sample))).not.toContain('$param')
    expect(JSON.stringify(build(recipe, requiredOnly(recipe)))).not.toContain('$param')
  })

  it('has one trigger, unique node ids, and a Korean workflow name equal to its Korean title', () => {
    const workflow = build(recipe, recipe.sample)
    expect(workflow.nodes.filter((node) => isTrigger(node.type))).toHaveLength(1)
    expect(new Set(workflow.nodes.map((node) => node.id)).size).toBe(workflow.nodes.length)
    expect(workflow.name).toBe(recipe.title.ko)
  })

  it('holds a double brace only inside a genuine node reference', () => {
    for (const values of [recipe.sample, requiredOnly(recipe)]) {
      const workflow = build(recipe, values)
      for (const leaf of stringLeaves(workflow)) {
        expect(findMalformedTemplates(leaf.value), leaf.pointer).toEqual([])
        expect(leaf.value.split('{{').length - 1, leaf.pointer).toBe(extractRefs(leaf.value).length)
        expect(leaf.value.split('}}').length - 1, leaf.pointer).toBe(extractRefs(leaf.value).length)
      }
    }
  })

  it('holds no token, secret, personal path, e-mail address or real host', () => {
    const secrets = [/xox[abeprs]-/i, /\bsk-[A-Za-z0-9_-]{8,}/, /\bgh[pousr]_/i, /AKIA[0-9A-Z]{12,}/, /\bbearer\s+\S/i, /hooks\.slack\.com/i, /[A-Za-z0-9+/_=-]{40,}/, /-----BEGIN/, /[\w.+-]+@[\w-]+\.[\w.]+/]
    const texts = [...everyText(recipe), ...everyText(build(recipe, recipe.sample))]
    for (const text of texts) {
      for (const pattern of secrets) expect(text, String(pattern)).not.toMatch(pattern)
      for (const host of text.matchAll(/https?:\/\/([^/\s:?#]+)/g)) expect(host[1], text).toBe('example.test')
      for (const path of text.matchAll(/\/(?:Users|home)\/([^/\s]+)/g)) expect(path[1], text).toBe('demo')
      expect(text).not.toMatch(/[A-Za-z]:\\/)
    }
  })

  it('has no folder, file or URL of its own: every such value comes from a parameter, apart from a webhook path', () => {
    const workflow = build(recipe, recipe.sample)
    const own = workflow.nodes.filter((node) => node.type !== 'trigger.webhook@1').flatMap((node) => leaves(node.config))
    const literals = own.filter((leaf): leaf is string => typeof leaf === 'string' && /^(https?:|\/|~)/.test(leaf))
    const fromSample = new Set(Object.values(recipe.sample))
    for (const text of literals) expect(fromSample.has(text), text).toBe(true)
    for (const node of workflow.nodes.filter((entry) => entry.type === 'trigger.webhook@1')) expect(node.config.path).toMatch(/^\/[a-z][a-z-]*$/)
  })

  it('refuses at validation a folder or file outside the allowed folders', () => {
    const paths = recipe.params.filter((param) => param.kind === 'folder' || param.kind === 'file')
    for (const param of paths) {
      const workflow = build(recipe, { ...recipe.sample, [param.id]: '/Users/other/Receipts/ledger.csv' })
      expect(codes(workflow).filter((code) => code.startsWith('path_outside_roots')), param.id).toHaveLength(1)
    }
  })

  it('refuses at validation a connection that is not configured', () => {
    const connections = recipe.params.filter((param) => param.kind === 'connection')
    for (const param of connections) {
      const workflow = build(recipe, { ...recipe.sample, [param.id]: 'not-configured' })
      expect(codes(workflow).filter((code) => code.startsWith('unknown_connection')), param.id).toHaveLength(1)
    }
  })

  it('does not pass a text that tries to become a reference', () => {
    for (const param of recipe.params.filter((entry) => entry.kind === 'text')) {
      const result = instantiateRecipe(recipe, { ...recipe.sample, [param.id]: '{{t1.output.file}}' })
      expect(result).toEqual({ problems: [{ param: param.id, rule: 'template_text' }] })
    }
  })
})

describe('the configuration of each recipe', () => {
  const nodeOf = (workflow: Workflow, id: string) => workflow.nodes.find((node) => node.id === id)!
  const shape = (workflow: Workflow) => ({
    nodes: workflow.nodes.map((node) => `${node.id}:${node.type}`),
    edges: workflow.edges.map((edge) => `${edge.from}>${edge.to}${edge.when === undefined ? '' : `:${edge.when}`}`),
  })
  const fields = [
    { name: 'amount', type: 'number', description: expect.any(String) },
    { name: 'date', type: 'date', description: expect.any(String) },
    { name: 'vendor', type: 'string', description: expect.any(String) },
  ]
  const recipeOf = (id: string) => findRecipe(id)!

  it('receipt-folder-to-csv watches a folder, extracts the amount, the date and the vendor and appends one row', () => {
    const recipe = recipeOf('receipt-folder-to-csv')
    expect(recipe.params.map((param) => [param.id, param.kind, param.required, param.default])).toEqual([
      ['watchFolder', 'folder', true, undefined],
      ['glob', 'glob', false, '*.pdf'],
      ['csvFile', 'file', true, undefined],
    ])
    const workflow = build(recipe, recipe.sample)
    expect(shape(workflow)).toEqual({ nodes: ['t1:trigger.folderWatch@1', 'n1:llm.extract@1', 'n2:csv.append@1'], edges: ['t1>n1', 'n1>n2'] })
    expect(nodeOf(workflow, 't1').config).toEqual({ folder: '/Users/demo/Receipts', glob: '*.png' })
    expect(nodeOf(workflow, 'n1').config).toEqual({ file: '{{t1.output.file}}', fields })
    expect(nodeOf(workflow, 'n1').retry).toEqual({ maxAttempts: 3 })
    expect(nodeOf(workflow, 'n2').config).toEqual({
      file: '/Users/demo/Receipts/ledger.csv',
      row: ['{{n1.output.date}}', '{{n1.output.vendor}}', '{{n1.output.amount}}'],
    })
    expect(nodeOf(build(recipe, requiredOnly(recipe)), 't1').config).toEqual({ folder: '/Users/demo/Receipts', glob: '*.pdf' })
  })

  it('receipt-big-amount-alert adds a branch that sends a Slack message above a threshold', () => {
    const recipe = recipeOf('receipt-big-amount-alert')
    expect(recipe.params.map((param) => [param.id, param.kind, param.required, param.default, param.min, param.max])).toEqual([
      ['watchFolder', 'folder', true, undefined, undefined, undefined],
      ['glob', 'glob', false, '*.pdf', undefined, undefined],
      ['csvFile', 'file', true, undefined, undefined, undefined],
      ['threshold', 'number', true, undefined, 0, 1_000_000_000_000],
      ['slackConnection', 'connection', true, undefined, undefined, undefined],
    ])
    const workflow = build(recipe, recipe.sample)
    expect(shape(workflow)).toEqual({
      nodes: ['t1:trigger.folderWatch@1', 'n1:llm.extract@1', 'n2:csv.append@1', 'n3:condition@1', 'n4:notify.slack@1'],
      edges: ['t1>n1', 'n1>n2', 'n1>n3', 'n3>n4:true'],
    })
    expect(nodeOf(workflow, 'n1').config).toEqual({ file: '{{t1.output.file}}', fields })
    expect(nodeOf(workflow, 'n3').config).toEqual({ left: '{{n1.output.amount}}', operator: 'gt', right: 100000 })
    expect(nodeOf(workflow, 'n4').config).toEqual({ connection: 'slack-ops', text: '한도를 넘는 영수증이 들어왔어요: {{n1.output.amount}}' })
  })

  it('daily-health-check calls a URL on a schedule and alerts when the status is not 200 or the call fails', () => {
    const recipe = recipeOf('daily-health-check')
    expect(recipe.params.map((param) => [param.id, param.kind, param.required, param.default])).toEqual([
      ['schedule', 'cron', false, '0 9 * * 1-5'],
      ['url', 'url', true, undefined],
      ['slackConnection', 'connection', true, undefined],
    ])
    const workflow = build(recipe, recipe.sample)
    expect(shape(workflow)).toEqual({ nodes: ['t1:trigger.cron@1', 'n1:http.request@1', 'n2:condition@1', 'n3:notify.slack@1'], edges: ['t1>n1', 'n1>n2', 'n2>n3:true'] })
    expect(nodeOf(workflow, 't1').config).toEqual({ expression: '30 8 * * 1-5' })
    expect(nodeOf(workflow, 'n1').config).toEqual({ url: 'https://example.test/health', method: 'GET' })
    expect(nodeOf(workflow, 'n1').onError).toBe('continue')
    expect(nodeOf(workflow, 'n2').config).toEqual({ left: '{{n1.output.status}}', operator: 'neq', right: 200 })
    expect(nodeOf(workflow, 'n3').config).toEqual({ connection: 'slack-ops', text: expect.any(String) })
    expect(nodeOf(build(recipe, requiredOnly(recipe)), 't1').config).toEqual({ expression: '0 9 * * 1-5' })
  })

  it('webhook-to-slack posts a fixed message for every request to a fixed local path', () => {
    const recipe = recipeOf('webhook-to-slack')
    expect(recipe.params.map((param) => [param.id, param.kind, param.required])).toEqual([['slackConnection', 'connection', true]])
    const workflow = build(recipe, recipe.sample)
    expect(shape(workflow)).toEqual({ nodes: ['t1:trigger.webhook@1', 'n1:notify.slack@1'], edges: ['t1>n1'] })
    expect(nodeOf(workflow, 't1').config).toEqual({ path: '/webhook-to-slack', method: 'POST' })
    expect(nodeOf(workflow, 'n1').config).toEqual({ connection: 'slack-ops', text: '웹훅 요청이 도착했어요.' })
  })

  it('monthly-reminder sends the text of the user on the first day of the month by default', () => {
    const recipe = recipeOf('monthly-reminder')
    expect(recipe.params.map((param) => [param.id, param.kind, param.required, param.default])).toEqual([
      ['schedule', 'cron', false, '0 9 1 * *'],
      ['message', 'text', false, '이번 달 정산을 확인할 시간이에요.'],
      ['slackConnection', 'connection', true, undefined],
    ])
    const workflow = build(recipe, recipe.sample)
    expect(shape(workflow)).toEqual({ nodes: ['t1:trigger.cron@1', 'n1:notify.slack@1'], edges: ['t1>n1'] })
    expect(nodeOf(workflow, 't1').config).toEqual({ expression: '0 10 1 * *' })
    expect(nodeOf(workflow, 'n1').config).toEqual({ connection: 'slack-ops', text: 'Time to send the monthly report' })
    const defaults = build(recipe, requiredOnly(recipe))
    expect(nodeOf(defaults, 't1').config).toEqual({ expression: '0 9 1 * *' })
    expect(nodeOf(defaults, 'n1').config).toEqual({ connection: 'slack-ops', text: '이번 달 정산을 확인할 시간이에요.' })
  })

  it('failure-webhook-alert alerts when the status in the request body is the failure status', () => {
    const recipe = recipeOf('failure-webhook-alert')
    expect(recipe.params.map((param) => [param.id, param.kind, param.required, param.default])).toEqual([
      ['slackConnection', 'connection', true, undefined],
      ['failedStatus', 'text', false, 'failed'],
    ])
    const workflow = build(recipe, recipe.sample)
    expect(shape(workflow)).toEqual({ nodes: ['t1:trigger.webhook@1', 'n1:condition@1', 'n2:notify.slack@1'], edges: ['t1>n1', 'n1>n2:true'] })
    expect(nodeOf(workflow, 't1').config).toEqual({ path: '/failure-alert', method: 'POST' })
    expect(nodeOf(workflow, 'n1').config).toEqual({ left: '{{t1.output.body.status}}', operator: 'eq', right: 'error' })
    expect(nodeOf(workflow, 'n2').config).toEqual({ connection: 'slack-ops', text: expect.any(String) })
    expect(nodeOf(build(recipe, requiredOnly(recipe)), 'n1').config).toEqual({ left: '{{t1.output.body.status}}', operator: 'eq', right: 'failed' })
  })
})
