import {
  flagKey,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_ITEMS,
  RillError,
  validateParams,
  type Agent,
  type EngineEvent,
  type Hook,
  type HookLogEntry,
  type LlmModelInfo,
  type LlmModelsResult,
  type MemoryItem,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type PlanMeta,
  type PlanResultBody,
  type Rule,
  type Skill,
} from '@rill/protocol'
import { baseNodeType } from '../model/rules'
import type { EngineClient } from './client'
import { createFakeAgents, type FakeAgents } from './fake-agents'
import { createFakeHooks, type FakeHooks } from './fake-hooks'
import { createFakeReviews, type ReviewScript } from './fake-review'
import { createFakeRules, metaUnderCap, type FakeRules, type RuleViolationScript } from './fake-rules'
import { createFakeSkills, type FakeSkills } from './fake-skills'

export type PlanOutcome = { result: PlanResultBody; meta: PlanMeta }

type FakeConnections = ReadonlyArray<{ name: string; kind: string }>

export interface FakePlanData {
  models: LlmModelsResult
  script: (params: MethodParams<'plan'>) => PlanOutcome | RillError | 'hang'
  memory: MemoryItem[]
  agents?: readonly Agent[]
  activeAgentId?: string
  skills?: readonly Skill[]
  review?: ReviewScript
  rules?: readonly Rule[]
  violations?: RuleViolationScript
  hooks?: readonly Hook[]
  hookLog?: readonly HookLogEntry[]
  connections?: FakeConnections | (() => FakeConnections | Promise<FakeConnections>)
  deployId?: string
  delayMs?: number
  now?: () => number
  seed?: ReadonlyArray<{ planId: string; result: PlanResultBody }>
}

const HANDLED = [
  'plan',
  'cancelPlan',
  'deployPlan',
  'llmModels',
  'listMemory',
  'saveMemory',
  'deleteMemory',
  'listAgents',
  'saveAgent',
  'deleteAgent',
  'setActiveAgent',
  'listSkills',
  'saveSkill',
  'deleteSkill',
  'reviewPlan',
  'listRules',
  'saveRule',
  'deleteRule',
  'checkRules',
  'listHooks',
  'saveHook',
  'deleteHook',
  'listHookLog',
] as const satisfies readonly MethodName[]
type Handled = (typeof HANDLED)[number]

const MAX_PENDING = 2

type MemoryRule = 'empty' | 'control_character' | 'line_separator' | 'bidi_format' | 'format_character' | 'too_long'

const RULE_TEXT: Readonly<Record<MemoryRule, string>> = {
  empty: 'a note is not empty',
  control_character: 'a note is one line without control characters',
  line_separator: 'a note is one line without line or paragraph separators',
  bidi_format: 'a note has no bidirectional formatting characters',
  format_character: 'a note has no invisible format characters',
  too_long: `a note is at most ${MEMORY_MAX_CHARS} characters`,
}

const CONTROL = /\p{Cc}/u
const SEPARATOR = /[\p{Zl}\p{Zp}]/u
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u
const FORMAT = /(?![‌‍])\p{Cf}|[\u{e0100}-\u{e01ef}]/u
const SPACES = /\s+/gu

function invalidNote(rule: MemoryRule): RillError {
  return new RillError('MEMORY_INVALID', 'the note is not valid', [`${rule}: ${RULE_TEXT[rule]}`])
}

function normalise(raw: string): string {
  const trimmed = raw.normalize('NFC').trim()
  if (trimmed === '') throw invalidNote('empty')
  if (CONTROL.test(trimmed)) throw invalidNote('control_character')
  if (SEPARATOR.test(trimmed)) throw invalidNote('line_separator')
  if (BIDI.test(trimmed)) throw invalidNote('bidi_format')
  if (FORMAT.test(trimmed)) throw invalidNote('format_character')
  const text = trimmed.replace(SPACES, ' ')
  if ([...text].length > MEMORY_MAX_CHARS) throw invalidNote('too_long')
  return text
}

function keyOf(text: string): string {
  return text.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}

interface PlanRecord {
  result: PlanResultBody
  flagKeys: string[]
  workflowId?: string
}

function activeModelOf(result: LlmModelsResult): LlmModelInfo | undefined {
  const { active } = result
  return active === null ? undefined : result.models.find((model) => model.provider === active.provider && model.id === active.model)
}

export type FakePlanClient = EngineClient & { pendingPlans(): string[]; planAgentIds(): Array<string | undefined>; agents: FakeAgents; skills: FakeSkills; rules: FakeRules; hooks: FakeHooks }

export function withPlanMethods(client: EngineClient & { emit?: (event: EngineEvent) => void }, data: FakePlanData): FakePlanClient {
  const records = new Map<string, PlanRecord>()
  for (const item of data.seed ?? []) records.set(item.planId, { result: structuredClone(item.result), flagKeys: item.result.kind === 'workflow' ? item.result.flags.map(flagKey) : [] })
  const pending = new Map<string, (error: RillError) => void>()
  const memory: MemoryItem[] = structuredClone(data.memory)
  const now = data.now ?? Date.now
  const skills = createFakeSkills({ ...(data.skills === undefined ? {} : { skills: data.skills }), now })
  const agents = createFakeAgents({ ...(data.agents === undefined ? {} : { agents: data.agents }), ...(data.activeAgentId === undefined ? {} : { activeId: data.activeAgentId }), skills: skills.all, now })
  const rules = createFakeRules({ ...(data.rules === undefined ? {} : { rules: data.rules }), ...(data.violations === undefined ? {} : { violations: data.violations }), now })
  const hooks = createFakeHooks({ ...(data.hooks === undefined ? {} : { hooks: data.hooks }), ...(data.hookLog === undefined ? {} : { log: data.hookLog }), now })
  const reviews = createFakeReviews({ ...(data.review === undefined ? {} : { script: data.review }), ...(data.delayMs === undefined ? {} : { delayMs: data.delayMs }) })
  const planAgents: Array<string | undefined> = []
  let memorySerial = 0
  let deploySerial = 0

  client.onEvent((event) => {
    if (event.type !== 'workflow.deleted') return
    for (const record of records.values()) if (record.workflowId === event.workflowId) delete record.workflowId
    hooks.removeWorkflow(event.workflowId)
  })

  function plan(params: MethodParams<'plan'>): Promise<MethodResult<'plan'>> {
    agents.resolve(params.agentId)
    if (records.has(params.planId) || pending.has(params.planId)) throw new RillError('PLAN_EXISTS', 'a plan with this id already exists')
    if (pending.size >= MAX_PENDING) throw new RillError('PLAN_BUSY', `too many plans are running (at most ${MAX_PENDING} at a time)`)
    planAgents.push(params.agentId)
    const answer = data.script(structuredClone(params))
    return new Promise((resolve, reject) => {
      pending.set(params.planId, reject)
      if (answer === 'hang') return
      const finish = (): void => {
        if (!pending.delete(params.planId)) return
        if (answer instanceof RillError) {
          reject(answer)
          return
        }
        const flagKeys = answer.result.kind === 'workflow' ? answer.result.flags.map(flagKey) : []
        records.set(params.planId, { result: structuredClone(answer.result), flagKeys })
        resolve({ planId: params.planId, result: structuredClone(answer.result), meta: structuredClone(metaUnderCap(answer.meta, params.effort, rules.cap(), activeModelOf(data.models))) })
      }
      if ((data.delayMs ?? 0) > 0) setTimeout(finish, data.delayMs)
      else queueMicrotask(finish)
    })
  }

  function cancelPlan({ planId }: MethodParams<'cancelPlan'>): MethodResult<'cancelPlan'> {
    const reject = pending.get(planId)
    if (reject === undefined) return { cancelled: false }
    pending.delete(planId)
    reject(new RillError('PLAN_CANCELLED', 'planning was cancelled'))
    return { cancelled: true }
  }

  function deployPlan({ planId, confirmed }: MethodParams<'deployPlan'>): MethodResult<'deployPlan'> {
    const record = records.get(planId)
    if (record === undefined) throw new RillError('NOT_FOUND', `plan not found: ${planId}`)
    if (record.result.kind !== 'workflow' || record.workflowId !== undefined) throw new RillError('PLAN_DEPLOYED', 'the plan cannot be deployed again')
    const given = new Set(confirmed)
    const known = new Set(record.flagKeys)
    const missing = record.flagKeys.some((key) => !given.has(key))
    const stray = [...given].some((key) => !known.has(key))
    if (missing || stray) throw new RillError('PLAN_NOT_CONFIRMED', 'confirm every flag of the plan before deploying')
    deploySerial += 1
    record.workflowId = data.deployId ?? `wf-deployed-${deploySerial}`
    client.emit?.({ type: 'plan.deployed', at: now(), workflowId: record.workflowId, planId })
    return { workflowId: record.workflowId }
  }

  function saveMemory({ id, text: raw }: MethodParams<'saveMemory'>): MethodResult<'saveMemory'> {
    const text = normalise(raw)
    const key = keyOf(text)
    const at = now()
    if (id !== undefined) {
      const found = memory.find((item) => item.id === id)
      if (found === undefined) throw new RillError('NOT_FOUND', 'memory note not found')
      if (memory.some((item) => item.id !== id && keyOf(item.text) === key)) throw new RillError('MEMORY_DUPLICATE', 'a note with the same text is already saved')
      found.text = text
      found.updatedAt = at
      return { item: structuredClone(found) }
    }
    if (memory.some((item) => keyOf(item.text) === key)) throw new RillError('MEMORY_DUPLICATE', 'a note with the same text is already saved')
    if (memory.length >= MEMORY_MAX_ITEMS) throw new RillError('MEMORY_FULL', `at most ${MEMORY_MAX_ITEMS} notes can be saved; delete one first`)
    memorySerial += 1
    const item: MemoryItem = { id: `mem-new-${memorySerial}`, text, createdAt: at, updatedAt: at }
    memory.push(item)
    return { item: structuredClone(item) }
  }

  function deleteMemory({ id }: MethodParams<'deleteMemory'>): MethodResult<'deleteMemory'> {
    const at = memory.findIndex((item) => item.id === id)
    if (at < 0) return { deleted: false }
    memory.splice(at, 1)
    return { deleted: true }
  }

  const handlers: { [M in Handled]: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>> } = {
    plan,
    cancelPlan,
    deployPlan,
    llmModels: () => structuredClone(data.models),
    listMemory: () => ({ items: structuredClone(memory) }),
    saveMemory,
    deleteMemory,
    listAgents: () => agents.list(),
    saveAgent: (params) => agents.save(params),
    deleteAgent: (params) => agents.remove(params),
    setActiveAgent: (params) => agents.setActive(params),
    listSkills: () => skills.list(),
    saveSkill: (params) => skills.save(params, agents.skillLists()),
    deleteSkill: (params) => {
      const answer = skills.remove(params)
      if (answer.deleted) agents.dropSkill(params.id)
      return answer
    },
    reviewPlan: (params) => reviews.run(params, { plan: (planId) => records.get(planId)?.result, agents, model: activeModelOf(data.models) }),
    listRules: () => rules.list(),
    saveRule: async (params) => {
      const { nodes } = await client.request('nodeCatalog', {})
      return rules.save(params, new Set(nodes.map((node) => baseNodeType(node.type))))
    },
    deleteRule: (params) => rules.remove(params),
    checkRules: () => rules.check(),
    listHooks: () => hooks.list(),
    saveHook: async (params) => {
      const { workflows } = await client.request('listWorkflows', {})
      const connections = typeof data.connections === 'function' ? await data.connections() : (data.connections ?? [])
      return hooks.save(params, {
        workflowIds: new Set(workflows.map((workflow) => workflow.id)),
        connections: new Map(connections.map((connection) => [connection.name, connection.kind])),
        notifyForbidden: rules.list().rules.some((rule) => rule.kind === 'forbidNode' && baseNodeType(rule.value).toLowerCase() === 'notify.slack'),
      })
    },
    deleteHook: (params) => hooks.remove(params),
    listHookLog: (params) => hooks.log(params),
  }

  return {
    async request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
      if (!(HANDLED as readonly string[]).includes(method)) return client.request(method, params)
      const checked = validateParams(method, params)
      if (!checked.ok) throw new RillError(checked.code, 'the parameters do not match the method', checked.problems)
      const handler = handlers[method as Handled] as unknown as (given: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>
      return handler(structuredClone(params))
    },
    onEvent: (listener) => client.onEvent(listener),
    pendingPlans: () => [...pending.keys()],
    planAgentIds: () => [...planAgents],
    agents,
    skills,
    rules,
    hooks,
  }
}
