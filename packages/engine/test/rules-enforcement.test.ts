import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanIssue } from '@rill/dsl'
import { PlanError } from '@rill/planner'
import { PlanRecordSchema } from '@rill/protocol'
import { RECIPES } from '@rill/recipes'
import Value from 'typebox/value'
import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { Engine, WorkflowValidationError, type EngineOptions } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { RULE_VIOLATION_MESSAGE, RuleViolationError } from '../src/rules'
import { RecipeInvalidError } from '../src/recipes'
import { ManualClock } from './manual-clock'
import { ScriptedProvider, flaggedWorkflow, patchReply, plainWorkflow, planInput, questionsReply, workflowReply, type Step } from './plan-helpers'

const START = Date.UTC(2026, 10, 11, 10, 0, 30)
const FIXED = 'this host is not in the allowed hosts'
const API = 'https://api.example.com/x'

const realFetch = globalThis.fetch
let dir: string
const engines: Engine[] = []
let fetched: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-rules-enf-'))
  fetched = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      fetched.push(String(input))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const engine of engines.splice(0)) await engine.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config })
const call = (url: string, id = 'n1') => node(id, 'http.request@1', { url })
const wf = (name: string, nodes: unknown[]) => ({
  schemaVersion: 1,
  name,
  nodes,
  edges: (nodes as Array<{ id: string }>).slice(1).map((entry, index) => ({ from: (nodes as Array<{ id: string }>)[index]!.id, to: entry.id })),
})
const manual = node('t1', 'trigger.manual@1')
const cron = node('t1', 'trigger.cron@1', { expression: '* * * * *', timezone: 'utc' })
const webhook = (path = '/hooks/a') => node('t1', 'trigger.webhook@1', { path })

interface Gate {
  entered: string[]
  release(): void
}

function registryWithGate(gate: Gate) {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  gate.release = open
  return createCoreRegistry().register(
    defineAction({
      type: 'test.gate@1',
      title: 'Gate',
      description: 'Waits until it is released.',
      sideEffect: 'none',
      configSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({}),
      execute: async (_config, ctx) => {
        gate.entered.push(ctx.runId)
        await opened
        return {}
      },
    }),
  )
}

function setup(options: Partial<EngineOptions> & { steps?: Step[] } = {}) {
  const { steps, ...rest } = options
  const gate: Gate = { entered: [], release: () => undefined }
  const clock = new ManualClock(START)
  const events: EngineEvent[] = []
  const provider = steps === undefined ? undefined : new ScriptedProvider(steps)
  const db = Db.open(':memory:')
  const engine = new Engine({
    db,
    registry: registryWithGate(gate),
    clock,
    sleep: async () => undefined,
    random: () => 1,
    webhookPort: 0,
    allowedRoots: [dir],
    ...(provider === undefined ? {} : { llm: provider }),
    ...rest,
  })
  engines.push(engine)
  engine.on((event) => events.push(event))
  return { engine, db, clock, events, gate, provider }
}

const forbid = (engine: Engine, type: string) => engine.saveRule({ kind: 'forbidNode', value: type })
const allow = (engine: Engine, host: string) => engine.saveRule({ kind: 'allowHost', value: host })

function issuesOf(error: unknown): PlanIssue[] {
  if (error instanceof WorkflowValidationError) return error.problemIssues
  if (error instanceof RuleViolationError) return error.issues
  throw error
}

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

async function caughtAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

const codes = (issues: PlanIssue[]) => issues.map((issue) => `${issue.code} ${issue.pointer}`)

describe('deploy with rules', () => {
  it('deploys as before when no rule is set', () => {
    const { engine } = setup()
    expect(engine.deploy(wf('a', [manual, call('https://anything.example.net/')]))).toBeTypeOf('string')
  })

  it('refuses a forbidden node with the rule_violation issue and stores nothing', () => {
    const { engine } = setup()
    forbid(engine, 'http.request')
    const error = caught(() => engine.deploy(wf('a', [manual, call(API)])))
    expect(error).toBeInstanceOf(WorkflowValidationError)
    expect(codes(issuesOf(error))).toEqual(['rule_violation /nodes/1/type'])
    expect((error as WorkflowValidationError).problems[0]).toContain('http.request')
    expect(engine.listWorkflows()).toEqual([])
  })

  it('refuses a host that is not allowed, a template host and an invalid URL, and accepts an allowed host and a template path', () => {
    const { engine } = setup()
    allow(engine, 'api.example.com')
    for (const url of ['https://evil.example.net/x', 'https://api.example.com@evil.example.net/', 'https://{{t1.output.body.host}}/x', 'api.example.com/x']) {
      const error = caught(() => engine.deploy(wf('a', [webhook(), call(url)])))
      expect(codes(issuesOf(error)).includes('rule_violation /nodes/1/config/url'), url).toBe(true)
    }
    expect(engine.listWorkflows()).toEqual([])
    expect(engine.deploy(wf('ok', [webhook(), call('https://API.example.com/x')]))).toBeTypeOf('string')
    expect(engine.deploy(wf('ok2', [webhook(), call('https://api.example.com/{{t1.output.body.id}}')]))).toBeTypeOf('string')
    expect(engine.listWorkflows()).toHaveLength(2)
  })

  it('deploys again once the rule is deleted', () => {
    const { engine } = setup()
    const rule = forbid(engine, 'http.request')
    expect(() => engine.deploy(wf('a', [manual, call(API)]))).toThrow(WorkflowValidationError)
    engine.deleteRule(rule.id)
    expect(engine.deploy(wf('a', [manual, call(API)]))).toBeTypeOf('string')
  })

  it('applies the effort cap and a rule that is not about nodes or hosts without refusing anything', () => {
    const { engine } = setup()
    engine.saveRule({ kind: 'maxPlanEffort', value: 'low' })
    expect(engine.deploy(wf('a', [manual, call(API)]))).toBeTypeOf('string')
  })
})

describe('deployPlan with rules', () => {
  it('refuses a plan that was made before the rule, keeps the plan open and stores no workflow', async () => {
    const { engine } = setup({ steps: [{ data: workflowReply(flaggedWorkflow()) }] })
    const outcome = await engine.plan(planInput({ planId: 'p1', text: 'post out' }))
    const flags = outcome.result.kind === 'workflow' ? outcome.result.flags.map((flag) => JSON.stringify([flag.nodeId, flag.pointer, flag.code])) : []
    forbid(engine, 'http.request')
    const error = caught(() => engine.deployPlan('p1', flags))
    expect(error).toBeInstanceOf(WorkflowValidationError)
    expect(codes(issuesOf(error))).toEqual(['rule_violation /nodes/1/type'])
    expect(engine.listWorkflows()).toEqual([])
    expect(engine.getPlan('p1').workflowId).toBeNull()
  })

  it('deploys the same plan once the rule is gone', async () => {
    const { engine } = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    await engine.plan(planInput({ planId: 'p1' }))
    const rule = forbid(engine, 'delay')
    expect(() => engine.deployPlan('p1', [])).toThrow(WorkflowValidationError)
    engine.deleteRule(rule.id)
    expect(engine.deployPlan('p1', [])).toBeTypeOf('string')
  })
})

describe('instantiateRecipe with rules', () => {
  const options = { allowedRoots: ['/Users/demo'], planConnections: [{ name: 'slack-ops', kind: 'slack' as const }] }

  it('refuses a recipe that has a forbidden node, naming the rule_violation, and writes nothing', () => {
    const { engine } = setup(options)
    const recipe = RECIPES.find((entry) => entry.id === 'receipt-folder-to-csv')!
    expect(engine.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample }).workflow.nodes.length).toBeGreaterThan(1)
    forbid(engine, 'csv.append')
    const error = caught(() => engine.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample }))
    expect(error).toBeInstanceOf(RecipeInvalidError)
    expect((error as RecipeInvalidError).problems.some((problem) => problem.startsWith('rule_violation at /nodes/'))).toBe(true)
    expect(engine.listWorkflows()).toEqual([])
  })

  it('refuses a recipe whose URL is not in the allowed hosts and accepts it when it is', () => {
    const { engine } = setup(options)
    const recipe = RECIPES.find((entry) => entry.id === 'daily-health-check')!
    const url = String(recipe.sample.url)
    const host = new URL(url).hostname
    allow(engine, 'other.example.com')
    const error = caught(() => engine.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample }))
    expect(error).toBeInstanceOf(RecipeInvalidError)
    expect((error as RecipeInvalidError).problems).toEqual(['rule_violation at /nodes/1/config/url'])
    allow(engine, host)
    expect(engine.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample }).workflow.nodes.length).toBeGreaterThan(1)
  })

  it('does not change what a recipe gives when no rule is set', () => {
    const { engine } = setup(options)
    for (const recipe of RECIPES) {
      expect(engine.instantiateRecipe({ recipeId: recipe.id, values: recipe.sample }).recipeId).toBe(recipe.id)
    }
  })
})

describe('plan with rules', () => {
  it('lists the rules next to the folders in what the model reads, and nothing about them when there are none', async () => {
    const plain = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    await plain.engine.plan(planInput({ planId: 'a' }))
    expect(plain.provider!.requests[0]!.messages[0]!.content as string).not.toContain('Rules set by the user')

    const ruled = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    forbid(ruled.engine, 'notify.slack')
    allow(ruled.engine, 'api.example.com')
    allow(ruled.engine, '*.example.org')
    await ruled.engine.plan(planInput({ planId: 'a' }))
    const sent = ruled.provider!.requests[0]!.messages[0]!.content as string
    expect(sent).toContain('Rules set by the user, enforced by validation:')
    expect(sent).toContain('- Never use these node types: notify.slack.')
    expect(sent).toContain('api.example.com, *.example.org')
  })

  it('lets the planner repair a plan that breaks a rule, and records the round', async () => {
    const { engine, provider } = setup({ steps: [{ data: workflowReply(flaggedWorkflow()) }, { data: workflowReply(plainWorkflow()) }] })
    forbid(engine, 'http.request')
    const outcome = await engine.plan(planInput({ planId: 'p1' }))
    expect(outcome.result.kind).toBe('workflow')
    expect(outcome.meta.rounds).toHaveLength(2)
    expect(outcome.meta.rounds[0]!.issues.map((issue) => issue.code)).toEqual(['rule_violation'])
    expect(provider!.requests).toHaveLength(2)
    expect(engine.getPlan('p1').status).toBe('planned')
  })

  it('stores a failed plan and throws invalid_after_repair when the model keeps breaking the rule', async () => {
    const reply = { data: workflowReply(flaggedWorkflow()) }
    const { engine } = setup({ steps: [reply, reply, reply, reply] })
    forbid(engine, 'http.request')
    const error = await caughtAsync(engine.plan(planInput({ planId: 'p1' })))
    expect(error).toBeInstanceOf(PlanError)
    expect((error as PlanError).kind).toBe('invalid_after_repair')
    expect(engine.getPlan('p1')).toMatchObject({ status: 'failed', error: 'the plan was not valid after the repair rounds' })
  })

  it('validates a patch with the rules', async () => {
    const existing = plainWorkflow('existing')
    const add = { op: 'add_node' as const, node: node('n2', 'http.request@1', { url: 'https://evil.example.net/x' }) }
    const edge = { op: 'connect' as const, edge: { from: 'n1', to: 'n2' } }
    const good = { op: 'add_node' as const, node: node('n2', 'http.request@1', { url: 'https://api.example.com/x' }) }
    const { engine } = setup({ steps: [{ data: patchReply([add, edge]) }, { data: patchReply([good, edge]) }] })
    const workflowId = engine.store.saveWorkflow(existing)
    allow(engine, 'api.example.com')
    const outcome = await engine.plan(planInput({ planId: 'p1', text: 'add a call', workflowId, selection: { nodeId: 'n1' } }))
    expect(outcome.meta.rounds[0]!.issues.map((issue) => issue.code)).toEqual(['rule_violation'])
    expect(outcome.meta.rounds[1]!.issues).toEqual([])
  })

  it('lowers a request above the effort cap to the cap, says so in the meta and keeps the requested effort in the record', async () => {
    const { engine, provider } = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    engine.saveRule({ kind: 'maxPlanEffort', value: 'medium' })
    const outcome = await engine.plan(planInput({ planId: 'p1', effort: 'xhigh' }))
    expect(provider!.requests[0]!.effort).toBe('medium')
    expect(outcome.meta.effortDetail).toEqual({ requested: 'xhigh', effective: 'medium', native: 'medium', collapsed: true, cappedByRule: true })
    expect(outcome.meta.effort).toBe('xhigh')
    expect(engine.getPlan('p1').effort).toBe('xhigh')
    expect(engine.getPlan('p1').meta?.effortDetail?.cappedByRule).toBe(true)
  })

  it('leaves a request at or under the cap alone and reports cappedByRule false, with and without a cap', async () => {
    const capped = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    capped.engine.saveRule({ kind: 'maxPlanEffort', value: 'high' })
    const a = await capped.engine.plan(planInput({ planId: 'a', effort: 'high' }))
    expect(capped.provider!.requests[0]!.effort).toBe('high')
    expect(a.meta.effortDetail).toMatchObject({ requested: 'high', effective: 'high', cappedByRule: false })
    const free = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    const b = await free.engine.plan(planInput({ planId: 'b', effort: 'max' }))
    expect(free.provider!.requests[0]!.effort).toBe('max')
    expect(b.meta.effortDetail).toMatchObject({ requested: 'max', effective: 'max', cappedByRule: false })
  })

  it('answers a request above the cap with a plan, not an error, and reads a cap saved later', async () => {
    const { engine, provider } = setup({ steps: [{ data: workflowReply(plainWorkflow()) }, { data: workflowReply(plainWorkflow()) }] })
    await engine.plan(planInput({ planId: 'a', effort: 'max' }))
    engine.saveRule({ kind: 'maxPlanEffort', value: 'low' })
    const second = await engine.plan(planInput({ planId: 'b', effort: 'max' }))
    expect(second.result.kind).toBe('workflow')
    expect(provider!.requests.map((request) => request.effort)).toEqual(['max', 'low'])
  })

  it('also caps an effort the provider would lower further on its own', async () => {
    const { engine } = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    engine.saveRule({ kind: 'maxPlanEffort', value: 'low' })
    const outcome = await engine.plan(planInput({ planId: 'a', effort: 'low' }))
    expect(outcome.meta.effortDetail).toMatchObject({ requested: 'low', effective: 'low', cappedByRule: false })
  })
})

interface Frozen {
  name: string
  kind: string
  effortDetail: Record<string, unknown>
  requests: unknown[]
}

const frozen = JSON.parse(readFileSync(new URL('./fixtures/frozen-plan-requests.json', import.meta.url), 'utf8')) as Frozen[]
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function scenario(name: string, steps: Step[], input: Record<string, unknown>, prepare?: (engine: Engine) => string | undefined, rules?: (engine: Engine) => void) {
  const provider = new ScriptedProvider(steps)
  const db = Db.open(':memory:')
  const engine = new Engine({
    db,
    registry: createCoreRegistry(),
    llm: provider,
    now: () => 1000,
    allowedRoots: ['/Users/demo'],
    planConnections: [
      { name: 'team-alerts', kind: 'slack', slack: 'bot' },
      { name: 'api-key', kind: 'http' },
    ],
  })
  engines.push(engine)
  rules?.(engine)
  const workflowId = prepare?.(engine)
  const outcome = await engine.plan(planInput({ planId: name, ...input, ...(workflowId === undefined ? {} : { workflowId }) } as never))
  const requests = provider.requests.map((request) => ({
    systemBlocks: (typeof request.system === 'object' ? request.system : []).map((block) => ({ length: block.text.length, sha256: sha(block.text), cache: block.cache === true })),
    messages: request.messages,
    schemaSha256: sha(JSON.stringify(request.schema)),
    maxTokens: request.maxTokens,
    effort: request.effort,
  }))
  return { name, kind: outcome.result.kind, effortDetail: outcome.meta.effortDetail, requests }
}

function scenarios(rules?: (engine: Engine) => void) {
  const existing = plainWorkflow('existing')
  return Promise.all([
    scenario('plain', [{ data: workflowReply(plainWorkflow()) }], { text: 'Wait a little', effort: 'medium' }, undefined, rules),
    scenario('high', [{ data: workflowReply(plainWorkflow()) }], { text: 'Wait a little', effort: 'xhigh' }, undefined, rules),
    scenario(
      'turns',
      [{ data: workflowReply(plainWorkflow()) }],
      {
        text: 'ok, ten ms',
        turns: [
          { role: 'user', text: 'Wait a little' },
          { role: 'assistant', text: '', result: { kind: 'questions', questions: [{ id: 'q1', text: 'How long?', options: ['5 ms', '10 ms'], default: '5 ms' }], summary: 'need to know' } },
          { role: 'user', text: 'ten', answers: { q1: '10 ms' } },
        ],
      },
      undefined,
      rules,
    ),
    scenario('patch', [{ data: patchReply([{ op: 'set_config', nodeId: 'n1', config: { ms: 10 } }]) }], { text: 'make it ten ms', selection: { nodeId: 'n1' } }, (engine) => engine.store.saveWorkflow(existing), rules),
    scenario('repair', [{ data: workflowReply({ ...plainWorkflow(), nodes: [plainWorkflow().nodes[0]!, { id: 'n1', type: 'nope@1', config: {} }] }) }, { data: workflowReply(plainWorkflow()) }], { text: 'Wait a little' }, undefined, rules),
    scenario('flagged', [{ data: workflowReply(flaggedWorkflow()) }], { text: 'post it to https://hooks.invalid/collect' }, undefined, rules),
    scenario('questions', [{ data: questionsReply() }], { text: 'Wait' }, undefined, rules),
  ])
}

describe('the model request with no rule that matters is byte-identical to the frozen copy', () => {
  it('has seven frozen scenarios from before rules existed', () => {
    expect(frozen.map((entry) => entry.name)).toEqual(['plain', 'high', 'turns', 'patch', 'repair', 'flagged', 'questions'])
    expect(frozen.reduce((sum, entry) => sum + entry.requests.length, 0)).toBe(8)
  })

  const variants: Array<[string, ((engine: Engine) => void) | undefined]> = [
    ['no rule', undefined],
    ['an effort cap that does not bind', (engine) => void engine.saveRule({ kind: 'maxPlanEffort', value: 'max' })],
  ]

  it.each(variants)('with %s: every request, system block hash and schema hash is the same', async (_name, rules) => {
    const actual = await scenarios(rules)
    for (const [index, entry] of frozen.entries()) {
      expect(JSON.stringify(actual[index]!.requests), entry.name).toBe(JSON.stringify(entry.requests))
      expect(actual[index]!.kind, entry.name).toBe(entry.kind)
      expect(actual[index]!.effortDetail, entry.name).toEqual({ ...entry.effortDetail, cappedByRule: false })
    }
  })

  const ruleVariants: Array<[string, (engine: Engine) => void, string]> = [
    ['a node rule and a host rule', (engine) => void [engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' }), engine.saveRule({ kind: 'allowHost', value: 'hooks.invalid' })], '\\nRules set by the user, enforced by validation:\\n- Never use these node types: [^\\n]*\\n- http\\.request may only call these hosts: [^\\n]*'],
    ['only a node rule', (engine) => void engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' }), '\\nRules set by the user, enforced by validation:\\n- Never use these node types: [^\\n]*'],
    ['only a host rule', (engine) => void engine.saveRule({ kind: 'allowHost', value: 'hooks.invalid' }), '\\nRules set by the user, enforced by validation:\\n- http\\.request may only call these hosts: [^\\n]*'],
  ]

  it.each(ruleVariants)('with %s: differs from the frozen copy only in the rules lines of the user message', async (_name, rules, lines) => {
    const actual = await scenarios(rules)
    const strip = new RegExp(lines, 'g')
    type Request = { systemBlocks: unknown; messages: Array<{ content: unknown }>; schemaSha256: string; maxTokens: number; effort: string }
    for (const [index, entry] of frozen.entries()) {
      const was = entry.requests as Request[]
      const now = actual[index]!.requests as Request[]
      expect(JSON.stringify(now), entry.name).not.toBe(JSON.stringify(was))
      expect(now.length, entry.name).toBe(was.length)
      for (const [round, request] of now.entries()) {
        const before = was[round]!
        expect(request.systemBlocks, `${entry.name} ${round} system blocks`).toEqual(before.systemBlocks)
        expect(request.schemaSha256, `${entry.name} ${round} schema`).toBe(before.schemaSha256)
        expect(request.maxTokens, `${entry.name} ${round} max tokens`).toBe(before.maxTokens)
        expect(request.effort, `${entry.name} ${round} effort`).toBe(before.effort)
        const stripped = request.messages.map((message) => ({
          ...message,
          content: typeof message.content === 'string' ? message.content.replace(strip, '') : message.content,
        }))
        expect(JSON.stringify(stripped), `${entry.name} ${round} messages`).toBe(JSON.stringify(before.messages))
      }
    }
  })
})

describe('plan records from before rules existed', () => {
  it('are served with cappedByRule false and pass the closed protocol schema', () => {
    const { engine, db } = setup()
    const meta = {
      rounds: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: null,
      model: 'm',
      effort: 'high',
      fallbackUsed: false,
      provider: 'anthropic',
      effortDetail: { requested: 'high', effective: 'high', native: 'high', collapsed: false },
    }
    db.run(
      "INSERT INTO plans (id, created_at, status, effort, model, request_text, attachments, meta) VALUES ('old', 1, 'failed', 'high', NULL, 'text', '[]', ?)",
      JSON.stringify(meta),
    )
    const record = engine.getPlan('old')
    expect(record.meta?.effortDetail).toEqual({ requested: 'high', effective: 'high', native: 'high', collapsed: false, cappedByRule: false })
    expect(Value.Check(PlanRecordSchema, record)).toBe(true)
  })

  it('keep a cappedByRule that is already there', async () => {
    const { engine } = setup({ steps: [{ data: workflowReply(plainWorkflow()) }] })
    engine.saveRule({ kind: 'maxPlanEffort', value: 'low' })
    await engine.plan(planInput({ planId: 'p', effort: 'high' }))
    expect(engine.getPlan('p').meta?.effortDetail?.cappedByRule).toBe(true)
  })
})

describe('activate with rules', () => {
  it('refuses to activate a stored workflow that now breaks a rule and leaves it inactive', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('cron', [cron, call(API)]))
    forbid(engine, 'http.request')
    const error = await caughtAsync(engine.activate(id))
    expect(error).toBeInstanceOf(RuleViolationError)
    expect((error as Error).message).toBe('the workflow breaks a rule you set; remove the rule or change the workflow')
    expect(codes(issuesOf(error))).toEqual(['rule_violation /nodes/1/type'])
    expect(engine.listWorkflows()[0]!.active).toBe(false)
    expect(engine.store.listActiveWorkflowIds()).toEqual([])
  })

  it('refuses for a host rule added later, and activates once the rule is deleted', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('cron', [cron, call('https://evil.example.net/x')]))
    const rule = allow(engine, 'api.example.com')
    await expect(engine.activate(id)).rejects.toBeInstanceOf(RuleViolationError)
    engine.deleteRule(rule.id)
    await engine.activate(id)
    expect(engine.store.listActiveWorkflowIds()).toEqual([id])
  })

  it('does not check a workflow that follows every rule, and no other check changes', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('cron', [cron, call(API)]))
    allow(engine, 'api.example.com')
    forbid(engine, 'notify.slack')
    await engine.activate(id)
    expect(engine.store.listActiveWorkflowIds()).toEqual([id])
  })

  it('does not start a workflow that was active before the rule when the engine resumes, and says why', async () => {
    const path = join(dir, 'resume.db')
    const db = Db.open(path)
    const gate: Gate = { entered: [], release: () => undefined }
    const clock = new ManualClock(START)
    const make = () => new Engine({ db, registry: registryWithGate(gate), clock, sleep: async () => undefined, webhookPort: 0 })
    const one = make()
    engines.push(one)
    const id = one.deploy(wf('cron', [cron, call(API)]))
    await one.activate(id)
    await one.shutdown()
    const two = make()
    engines.push(two)
    const events: EngineEvent[] = []
    two.on((event) => events.push(event))
    forbid(two, 'http.request')
    await two.resumeActive()
    expect(events.map((event) => event.type)).toEqual(['trigger.error'])
    expect(events[0]).toMatchObject({ workflowId: id, error: 'the workflow breaks a rule you set; remove the rule or change the workflow' })
    clock.advance(5 * 60_000)
    await two.idle()
    expect(two.listRuns()).toEqual([])
  })
})

describe('startRun with rules', () => {
  it('starts as before when no rule is set', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('a', [manual, call(API)]))
    expect((await engine.startRun(id)).status).toBe('succeeded')
    expect(fetched).toEqual([API])
  })

  it('refuses with RuleViolationError and creates no run, also for a dry run', async () => {
    const { engine, db } = setup()
    const id = engine.deploy(wf('a', [manual, call(API)]))
    forbid(engine, 'http.request')
    const error = caught(() => engine.enqueueRun(id))
    expect(error).toBeInstanceOf(RuleViolationError)
    expect(codes(issuesOf(error))).toEqual(['rule_violation /nodes/1/type'])
    await expect(engine.startRun(id)).rejects.toBeInstanceOf(RuleViolationError)
    expect(caught(() => engine.enqueueRun(id, {}, { dryRun: true }))).toBeInstanceOf(RuleViolationError)
    expect(db.all('SELECT * FROM runs')).toEqual([])
    expect(fetched).toEqual([])
  })

  it('refuses a workflow with a host that is not allowed or a template host, and runs one that is allowed', async () => {
    const { engine, db } = setup()
    const bad = engine.deploy(wf('bad', [webhook('/hooks/bad'), call('https://evil.example.net/x')]))
    const template = engine.deploy(wf('template', [webhook('/hooks/template'), call('https://{{t1.output.body.host}}/x')]))
    const good = engine.deploy(wf('good', [webhook('/hooks/good'), call(API)]))
    allow(engine, 'api.example.com')
    expect(caught(() => engine.enqueueRun(bad))).toBeInstanceOf(RuleViolationError)
    expect(caught(() => engine.enqueueRun(template, { body: { host: 'api.example.com' } }))).toBeInstanceOf(RuleViolationError)
    expect(db.all('SELECT * FROM runs')).toEqual([])
    expect((await engine.startRun(good, { body: {} })).status).toBe('succeeded')
    expect(fetched).toEqual([API])
  })

  it('runs again once the rule is deleted', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('a', [manual, call(API)]))
    const rule = forbid(engine, 'http.request')
    expect(caught(() => engine.enqueueRun(id))).toBeInstanceOf(RuleViolationError)
    engine.deleteRule(rule.id)
    expect((await engine.startRun(id)).status).toBe('succeeded')
  })

  it('reports an unknown workflow as not found, rules or not', async () => {
    const { engine } = setup()
    forbid(engine, 'http.request')
    expect((caught(() => engine.enqueueRun('missing')) as Error).name).toBe('NotFoundError')
  })
})

describe('triggers with rules', () => {
  it('does not start a run when a cron trigger fires for a workflow that now breaks a rule, and records run.blocked once per firing', async () => {
    const { engine, clock, events } = setup()
    const id = engine.deploy(wf('cron', [cron, call(API)]))
    await engine.activate(id)
    forbid(engine, 'http.request')
    clock.advance(30_000)
    await engine.idle()
    expect(engine.listRuns()).toEqual([])
    expect(fetched).toEqual([])
    expect(events.filter((event) => event.type === 'run.blocked')).toEqual([{ type: 'run.blocked', at: expect.any(Number), workflowId: id, codes: ['rule_violation'] }])
    expect(events.filter((event) => event.type === 'trigger.fired' || event.type === 'trigger.error' || event.type === 'run.started')).toEqual([])
    clock.advance(60_000)
    await engine.idle()
    expect(events.filter((event) => event.type === 'run.blocked')).toHaveLength(2)
  })

  it('fires again once the rule is deleted', async () => {
    const { engine, clock, events } = setup()
    const id = engine.deploy(wf('cron', [cron, call(API)]))
    await engine.activate(id)
    const rule = forbid(engine, 'http.request')
    clock.advance(30_000)
    await engine.idle()
    engine.deleteRule(rule.id)
    clock.advance(60_000)
    await engine.idle()
    expect(events.filter((event) => event.type === 'run.blocked')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'trigger.fired')).toHaveLength(1)
    expect(fetched).toEqual([API])
  })

  it('blocks a workflow that is not blocked by another rule only for the rule that it breaks', async () => {
    const { engine, clock, events } = setup()
    const id = engine.deploy(wf('cron', [cron, call(API)]))
    await engine.activate(id)
    forbid(engine, 'notify.slack')
    allow(engine, 'api.example.com')
    clock.advance(30_000)
    await engine.idle()
    expect(events.filter((event) => event.type === 'run.blocked')).toEqual([])
    expect(fetched).toEqual([API])
  })

  it('records run.blocked once for a file in a watched folder, however many times the folder is scanned', async () => {
    const folder = join(dir, 'in')
    mkdirSync(folder)
    const { engine, clock, events } = setup()
    const id = engine.deploy(wf('folder', [node('t1', 'trigger.folderWatch@1', { folder, pollMs: 1000, stableMs: 0 }), call(API)]))
    await engine.activate(id)
    forbid(engine, 'http.request')
    writeFileSync(join(folder, 'a.txt'), 'one')
    clock.advance(1000)
    clock.advance(1000)
    clock.advance(1000)
    await engine.idle()
    expect(events.filter((event) => event.type === 'run.blocked')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'trigger.error')).toEqual([])
    expect(engine.listRuns()).toEqual([])
    expect(engine.store.hasSeenFile(id, 'anything')).toBe(false)
    writeFileSync(join(folder, 'b.txt'), 'two')
    clock.advance(1000)
    await engine.idle()
    expect(events.filter((event) => event.type === 'run.blocked')).toHaveLength(2)
  })

  it('processes a file again after the rule is removed and the workflow is activated again, because the file was never recorded as seen', async () => {
    const folder = join(dir, 'in')
    mkdirSync(folder)
    const { engine, clock } = setup()
    const id = engine.deploy(wf('folder', [node('t1', 'trigger.folderWatch@1', { folder, pollMs: 1000, stableMs: 0 }), call(API)]))
    await engine.activate(id)
    const rule = forbid(engine, 'http.request')
    writeFileSync(join(folder, 'a.txt'), 'one')
    clock.advance(1000)
    await engine.idle()
    engine.deleteRule(rule.id)
    engine.deactivate(id)
    await engine.activate(id)
    clock.advance(1000)
    await engine.idle()
    expect(engine.listRuns()).toHaveLength(1)
    expect(fetched).toEqual([API])
  })

  it('answers a webhook call of a workflow that now breaks a rule with 403, starts no run and records run.blocked once', async () => {
    const { engine, events } = setup()
    const id = engine.deploy(wf('hook', [webhook('/hooks/a'), call(API)]))
    await engine.activate(id)
    forbid(engine, 'http.request')
    const response = await realFetch(`http://127.0.0.1:${engine.webhookPort()}/hooks/a`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'blocked by a rule' })
    await engine.idle()
    expect(engine.listRuns()).toEqual([])
    expect(events.filter((event) => event.type === 'run.blocked')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'trigger.error')).toEqual([])
    fetched.length = 0
  })

  it('still answers 202 for a webhook workflow that follows the rules', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('hook', [webhook('/hooks/a'), call(API)]))
    await engine.activate(id)
    forbid(engine, 'notify.slack')
    const response = await realFetch(`http://127.0.0.1:${engine.webhookPort()}/hooks/a`, { method: 'POST' })
    expect(response.status).toBe(202)
    await engine.idle()
  })
})

describe('runs that are already running', () => {
  function gatedWorkflow(url: string) {
    return wf('gated', [manual, node('g', 'test.gate@1'), call(url)])
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let index = 0; index < 500 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(check()).toBe(true)
  }

  it('is not cut when a rule that it breaks is saved while it runs', async () => {
    const { engine, gate } = setup()
    const id = engine.deploy(wf('gated', [manual, node('g', 'test.gate@1'), call(API)]))
    const run = engine.enqueueRun(id)
    await waitFor(() => gate.entered.length === 1)
    forbid(engine, 'http.request')
    forbid(engine, 'test.gate')
    allow(engine, 'zzz.example.com')
    gate.release()
    const result = await run.done
    expect(result.status).toBe('succeeded')
    expect(fetched).toEqual([API])
  })

  it('keeps using the host rules it started with, and the next run uses the new ones', async () => {
    const { engine, gate } = setup()
    const id = engine.deploy(gatedWorkflow(API))
    const first = allow(engine, 'api.example.com')
    const run = engine.enqueueRun(id)
    await waitFor(() => gate.entered.length === 1)
    engine.deleteRule(first.id)
    allow(engine, 'zzz.example.com')
    gate.release()
    expect((await run.done).status).toBe('succeeded')
    expect(fetched).toEqual([API])
    expect(caught(() => engine.enqueueRun(id))).toBeInstanceOf(RuleViolationError)
  })

  it('is not held to a host rule that was saved after it started', async () => {
    const { engine, gate } = setup()
    const id = engine.deploy(gatedWorkflow(API))
    const run = engine.enqueueRun(id)
    await waitFor(() => gate.entered.length === 1)
    allow(engine, 'zzz.example.com')
    gate.release()
    expect((await run.done).status).toBe('succeeded')
    expect(fetched).toEqual([API])
  })

  it('takes a fresh snapshot when a crashed run is resumed: a host that is no longer allowed fails the request before it is sent', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('hook', [webhook(), call('https://{{t1.output.body.host}}/x')]))
    const run = engine.store.createRun({ workflowId: id, payload: { body: { host: 'evil.example.net' } }, dryRun: false })
    engine.store.markRunRunning(run.id)
    allow(engine, 'api.example.com')
    const [result] = await engine.recover()
    expect(result?.status).toBe('failed')
    expect(result?.error).toBe(`node n1 failed: ${FIXED}`)
    expect(result?.error).not.toContain('evil')
    expect(fetched).toEqual([])
  })

  it('lets a resumed run send the request when its host is allowed by the fresh snapshot', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('hook', [webhook(), call('https://{{t1.output.body.host}}/x')]))
    const run = engine.store.createRun({ workflowId: id, payload: { body: { host: 'api.example.com' } }, dryRun: false })
    engine.store.markRunRunning(run.id)
    allow(engine, 'api.example.com')
    const [result] = await engine.recover()
    expect(result?.status).toBe('succeeded')
    expect(fetched).toEqual(['https://api.example.com/x'])
  })

  it('resumes a run that breaks a forbidNode rule, because the snapshot only holds the host rules', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('a', [manual, call(API)]))
    const run = engine.store.createRun({ workflowId: id, payload: {}, dryRun: false })
    engine.store.markRunRunning(run.id)
    forbid(engine, 'http.request')
    const [result] = await engine.recover()
    expect(result?.status).toBe('succeeded')
    expect(fetched).toEqual([API])
  })

  it('makes no request and no host failure in a dry run of a resumed run', async () => {
    const { engine } = setup()
    const id = engine.deploy(wf('hook', [webhook(), call('https://{{t1.output.body.host}}/x')]))
    const run = engine.store.createRun({ workflowId: id, payload: { body: { host: 'evil.example.net' } }, dryRun: true })
    engine.store.markRunRunning(run.id)
    allow(engine, 'api.example.com')
    const [result] = await engine.recover()
    expect(result?.status).toBe('succeeded')
    expect(fetched).toEqual([])
  })
})

describe('runs that wait in the queue', () => {
  async function waitFor(check: () => boolean): Promise<void> {
    for (let index = 0; index < 500 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(check()).toBe(true)
  }

  async function queuedBehindGate(options: { dryRun?: boolean } = {}) {
    const ctx = setup({ maxConcurrentRuns: 1 })
    const gated = ctx.engine.deploy(wf('gated', [manual, node('g', 'test.gate@1')]))
    const target = ctx.engine.deploy(wf('target', [manual, call(API)]))
    const first = ctx.engine.enqueueRun(gated)
    await waitFor(() => ctx.gate.entered.length === 1)
    const second = ctx.engine.enqueueRun(target, {}, options)
    return { ...ctx, first, second, target }
  }

  it('fails a queued run before any node when a forbidNode rule is saved while it waits, and says why with a fixed text', async () => {
    const { engine, gate, events, first, second, target } = await queuedBehindGate()
    forbid(engine, 'http.request')
    gate.release()
    expect((await first.done).status).toBe('succeeded')
    const result = await second.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe(RULE_VIOLATION_MESSAGE)
    expect(fetched).toEqual([])
    expect(engine.getRunDetail(second.runId).steps).toEqual([])
    expect(engine.getRunDetail(second.runId).run.status).toBe('failed')
    expect(events.filter((event) => event.type === 'run.blocked')).toEqual([{ type: 'run.blocked', at: expect.any(Number), workflowId: target, codes: ['rule_violation'] }])
    expect(events.filter((event) => event.type === 'run.started' && event.runId === second.runId)).toEqual([])
    expect(events.filter((event) => event.type === 'run.finished' && event.runId === second.runId)).toEqual([{ type: 'run.finished', at: expect.any(Number), runId: second.runId, status: 'failed', error: RULE_VIOLATION_MESSAGE }])
  })

  it('names each rule code once in run.blocked, however many nodes break a rule', async () => {
    const ctx = setup({ maxConcurrentRuns: 1 })
    const gated = ctx.engine.deploy(wf('gated', [manual, node('g', 'test.gate@1')]))
    const target = ctx.engine.deploy(wf('target', [manual, call(API, 'n1'), call(API, 'n2'), call('https://other.example.com/', 'n3')]))
    const first = ctx.engine.enqueueRun(gated)
    await waitFor(() => ctx.gate.entered.length === 1)
    const second = ctx.engine.enqueueRun(target)
    forbid(ctx.engine, 'http.request')
    ctx.gate.release()
    await first.done
    expect((await second.done).status).toBe('failed')
    expect(ctx.events.filter((event) => event.type === 'run.blocked')).toEqual([{ type: 'run.blocked', at: expect.any(Number), workflowId: target, codes: ['rule_violation'] }])
  })

  it('fails a queued dry run the same way', async () => {
    const { engine, gate, first, second } = await queuedBehindGate({ dryRun: true })
    forbid(engine, 'http.request')
    gate.release()
    await first.done
    const result = await second.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe(RULE_VIOLATION_MESSAGE)
  })

  it('fails a queued run whose host is not in a host rule that was saved while it waited, before any request', async () => {
    const { engine, gate, first, second } = await queuedBehindGate()
    allow(engine, 'zzz.example.com')
    gate.release()
    await first.done
    const result = await second.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe(RULE_VIOLATION_MESSAGE)
    expect(fetched).toEqual([])
  })

  it('runs a queued run that follows the rules saved while it waited', async () => {
    const { engine, gate, first, second } = await queuedBehindGate()
    forbid(engine, 'transform')
    allow(engine, 'api.example.com')
    gate.release()
    await first.done
    expect((await second.done).status).toBe('succeeded')
    expect(fetched).toEqual([API])
  })

  it('names no node, host or URL in the failure of a queued run', async () => {
    const { engine, gate, first, second } = await queuedBehindGate()
    forbid(engine, 'http.request')
    gate.release()
    await first.done
    const result = await second.done
    expect(result.error).not.toMatch(/http|api\.example|n1/)
  })

  it('fails a run that is still queued after a crash when recover finds it, and resumes a running one', async () => {
    const { engine, events } = setup()
    const id = engine.deploy(wf('a', [manual, call(API)]))
    const queued = engine.store.createRun({ workflowId: id, payload: {}, dryRun: false })
    const running = engine.store.createRun({ workflowId: id, payload: {}, dryRun: false })
    engine.store.markRunRunning(running.id)
    forbid(engine, 'http.request')
    const results = await engine.recover()
    const byId = new Map(results.map((result) => [result.runId, result]))
    expect(byId.get(queued.id)).toMatchObject({ status: 'failed', error: RULE_VIOLATION_MESSAGE })
    expect(byId.get(running.id)).toMatchObject({ status: 'succeeded' })
    expect(fetched).toEqual([API])
    expect(events.filter((event) => event.type === 'run.blocked')).toHaveLength(1)
  })

  it('also fails a queued run that a trigger fired before the rule was saved', async () => {
    const { engine, gate, clock, first } = await queuedBehindGate()
    void first
    const id = engine.deploy(wf('cron', [cron, call(API)]))
    await engine.activate(id)
    clock.advance(30_000)
    await waitFor(() => engine.listRuns({ workflowId: id }).length === 1)
    forbid(engine, 'http.request')
    gate.release()
    await engine.idle()
    const [run] = engine.listRuns({ workflowId: id })
    expect(run?.status).toBe('failed')
    expect(run?.error).toBe(RULE_VIOLATION_MESSAGE)
    expect(fetched).toEqual([])
  })
})

describe('checkRules', () => {
  it('lists nothing when there are no rules or no stored workflow breaks one', () => {
    const { engine } = setup()
    engine.deploy(wf('a', [manual, call(API)]))
    expect(engine.checkRules()).toEqual([])
    forbid(engine, 'notify.slack')
    expect(engine.checkRules()).toEqual([])
  })

  it('lists each stored workflow that breaks a rule, with its name and issues, and not the others', () => {
    const { engine } = setup()
    const bad = engine.deploy(wf('uses http', [manual, call(API)]))
    const fine = engine.deploy(wf('just waits', [manual, node('n1', 'delay@1', { ms: 5 })]))
    const hosts = engine.deploy(wf('wrong host', [webhook('/hooks/h'), call('https://evil.example.net/x')]))
    const template = engine.deploy(wf('template host', [webhook('/hooks/t'), call('https://{{t1.output.body.host}}/x')]))
    forbid(engine, 'http.request')
    const found = engine.checkRules()
    expect(found.map((entry) => entry.workflowId).sort()).toEqual([bad, hosts, template].sort())
    expect(found.map((entry) => entry.workflowId)).not.toContain(fine)
    const entry = found.find((candidate) => candidate.workflowId === bad)!
    expect(entry.name).toBe('uses http')
    expect(codes(entry.issues)).toEqual(['rule_violation /nodes/1/type'])
  })

  it('reports host problems, with no other kind of issue', () => {
    const { engine } = setup()
    engine.deploy(wf('wrong host', [webhook('/hooks/h'), call('https://evil.example.net/x')]))
    const id = engine.deploy(wf('template host', [webhook('/hooks/t'), call('https://{{t1.output.body.host}}/x')]))
    allow(engine, 'api.example.com')
    const found = engine.checkRules()
    expect(found).toHaveLength(2)
    for (const entry of found) expect(entry.issues.every((issue) => issue.code === 'rule_violation' && issue.stage === 3)).toBe(true)
    expect(found.find((entry) => entry.workflowId === id)!.issues[0]!.message).toContain('only known at run time')
  })

  it('is empty again once the rule is deleted', () => {
    const { engine } = setup()
    engine.deploy(wf('a', [manual, call(API)]))
    const rule = forbid(engine, 'http.request')
    expect(engine.checkRules()).toHaveLength(1)
    engine.deleteRule(rule.id)
    expect(engine.checkRules()).toEqual([])
  })

  it('returns at most 20 issues for one workflow', () => {
    const { engine } = setup()
    const nodes = [manual, ...Array.from({ length: 30 }, (_, index) => node(`n${index + 1}`, 'delay@1', { ms: 1 }))]
    engine.deploy(wf('many', nodes))
    forbid(engine, 'delay')
    const [entry] = engine.checkRules()
    expect(entry!.issues).toHaveLength(20)
  })

  it('returns at most 200 workflows, and says nothing about the others', () => {
    const { engine } = setup()
    for (let index = 0; index < 205; index++) engine.deploy(wf(`w${index}`, [manual, node('n1', 'delay@1', { ms: index + 1 })]))
    forbid(engine, 'delay')
    const found = engine.checkRules()
    expect(found).toHaveLength(200)
    expect(new Set(found.map((entry) => entry.workflowId)).size).toBe(200)
  })

  it('finds a violation even when it is not among the first 200 workflows stored', () => {
    const { engine } = setup()
    for (let index = 0; index < 205; index++) engine.deploy(wf(`w${index}`, [manual, node('n1', 'delay@1', { ms: index + 1 })]))
    const late = engine.deploy(wf('late', [manual, call(API)]))
    forbid(engine, 'http.request')
    expect(engine.checkRules().map((entry) => entry.workflowId)).toEqual([late])
  })
})
