import { isTrigger, type Workflow } from '@rill/dsl'
import {
  METHODS,
  RillError,
  type Agent,
  type EngineEvent,
  type ExplainResult,
  type Hook,
  type HookLogEntry,
  type LlmModelsResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NodeInfo,
  type Rule,
} from '@rill/protocol'
import Value from 'typebox/value'
import type { EngineClient } from '../engine/client'
import { createFakeClient, type FakeClient, type FakeWorkflow } from '../engine/fake-client'
import { withExplainMethod, type ExplainScript } from '../engine/fake-explain'
import { createFakeHost, type FakeHost, type FakeHostOptions, type FakeHostState } from '../engine/fake-host'
import { withPlanMethods, type FakePlanData } from '../engine/fake-plan'
import { withRecipeMethods, type FakeRecipeData } from '../engine/fake-recipes'
import { catalog, fakeData } from '../fixtures'
import { explainCases } from '../fixtures/explain'
import { memoryFixtures, models, outcomeOf, results } from '../fixtures/plan'
import { fixtureRecipeData } from '../fixtures/recipes'
import { baseNodeType, type RuleViolation } from '../model/rules'
import type { HostApi, Settings } from '../shared/host-api'
import type { ConnectedClient, ConnectFn } from './connection'

export function modelsFor(settings: Settings): LlmModelsResult {
  const configured = new Set(settings.configuredProviders)
  const providers = models.providers.map((provider) => ({ ...provider, configured: provider.id === settings.provider && configured.has(provider.id) }))
  const own = models.models.filter((model) => model.provider === settings.provider)
  const picked = configured.has(settings.provider) ? (settings.model === undefined ? own[0] : own.find((model) => model.id === settings.model)) : undefined
  return { models: structuredClone(models.models), providers, active: picked === undefined ? null : { provider: picked.provider, model: picked.id } }
}

export function withHostModels(client: EngineClient, host: Pick<HostApi, 'settings'>): EngineClient {
  return {
    onEvent: (listener) => client.onEvent(listener),
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method !== 'llmModels') return client.request(method, params)
      return modelsFor(await host.settings.get()) as MethodResult<M>
    },
  }
}

export interface FakeWorldControl {
  runOutcome: 'succeeded' | 'failed'
  activationError: boolean
  stepIntervalMs: number
}

export interface FakeWorldOptions {
  host?: FakeHost
  hostInit?: Partial<FakeHostState>
  hostOptions?: FakeHostOptions
  workflows?: readonly FakeWorkflow[]
  catalog?: readonly NodeInfo[]
  plan?: FakePlanData['script']
  planDelayMs?: number
  explain?: ExplainScript
  agents?: readonly Agent[]
  activeAgentId?: string
  hooks?: readonly Hook[]
  hookLog?: readonly HookLogEntry[]
  recipes?: FakeRecipeData
  control?: Partial<FakeWorldControl>
}

export interface FakeWorldCall {
  method: MethodName
  params: unknown
}

export interface FakeWorld {
  host: FakeHost
  client: EngineClient & { emit(event: EngineEvent): void }
  connect: ConnectFn
  control: FakeWorldControl
  calls: FakeWorldCall[]
  callsOf(method: MethodName): FakeWorldCall[]
  workflowIds(): string[]
}

const DEFAULT_EXPLAIN: ExplainScript = (params): ExplainResult => ({ ...structuredClone(explainCases.threeActions), runId: params.runId })

function failureText(node: string): string {
  return `node ${node} failed: HTTP 503 from https://api.example.com/health`
}

function hostOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : undefined
  } catch {
    return undefined
  }
}

function hostAllowed(host: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return host === pattern
  const suffix = pattern.slice(1)
  return host.length > suffix.length && host.endsWith(suffix)
}

function ruleViolations(workflows: Iterable<FakeWorkflow>, rules: readonly Rule[]): RuleViolation[] {
  const forbidden = new Set(rules.filter((rule) => rule.kind === 'forbidNode').map((rule) => rule.value))
  const hosts = rules.filter((rule) => rule.kind === 'allowHost').map((rule) => rule.value)
  if (forbidden.size === 0 && hosts.length === 0) return []
  return [...workflows].flatMap((entry) => {
    const issues = entry.workflow.nodes.flatMap((node, index) => {
      const type = baseNodeType(node.type)
      if (forbidden.has(type)) return [{ stage: 3 as const, pointer: `/nodes/${index}/type`, code: 'rule_violation', message: `node ${node.id}: the node type ${type} is forbidden by the rules` }]
      const url = (node.config as { url?: unknown } | undefined)?.url
      const host = type === 'http.request' && hosts.length > 0 && typeof url === 'string' ? hostOfUrl(url) : undefined
      if (host === undefined || hosts.some((pattern) => hostAllowed(host, pattern))) return []
      return [{ stage: 3 as const, pointer: `/nodes/${index}/config/url`, code: 'rule_violation', message: `node ${node.id}: the host ${host} is not in the allowed hosts` }]
    })
    return issues.length === 0 ? [] : [{ workflowId: entry.id, name: entry.workflow.name, issues }]
  })
}

export function createFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  const host = options.host ?? createFakeHost(options.hostInit, options.hostOptions)
  const control: FakeWorldControl = { runOutcome: 'succeeded', activationError: false, stepIntervalMs: 350, ...options.control }
  const registry = new Map<string, FakeWorkflow>((options.workflows ?? fakeData.workflows).map((entry) => [entry.id, structuredClone(entry)]))
  const nodeCatalog = options.catalog ?? catalog
  const base: FakeClient = createFakeClient({ ...fakeData, workflows: [], catalog: nodeCatalog })
  const plans = new Map<string, Workflow>()
  const calls: FakeWorldCall[] = []
  const inFlight = new Map<string, string>()
  let runSerial = 0
  base.onEvent((event) => {
    if (event.type === 'run.finished') inFlight.delete(event.runId)
  })

  const listed = { request: async (method, given) => (method === 'listWorkflows' ? (listWorkflows() as MethodResult<typeof method>) : base.request(method, given)), onEvent: (listener) => base.onEvent(listener) } satisfies EngineClient
  const planned = withPlanMethods(listed, {
    models,
    script: options.plan ?? (() => outcomeOf(results.workflow)),
    memory: [...memoryFixtures.three],
    violations: (rules) => ruleViolations(registry.values(), rules),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.activeAgentId === undefined ? {} : { activeAgentId: options.activeAgentId }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.hookLog === undefined ? {} : { hookLog: options.hookLog }),
    connections: async () => (await host.settings.get()).connections,
    ...(options.planDelayMs === undefined ? {} : { delayMs: options.planDelayMs }),
  })
  const recipes = withRecipeMethods(planned, options.recipes ?? fixtureRecipeData())
  const inner = withExplainMethod(recipes, options.explain ?? DEFAULT_EXPLAIN, { agents: planned.agents })

  function register(id: string, workflow: Workflow): void {
    registry.set(id, { id, workflow: structuredClone(workflow), active: false, createdAt: Date.now() })
  }

  function listWorkflows(): MethodResult<'listWorkflows'> {
    return {
      workflows: [...registry.values()]
        .map((entry) => ({
          id: entry.id,
          name: entry.workflow.name,
          active: entry.active ?? false,
          triggerType: entry.workflow.nodes.find((node) => isTrigger(node.type))?.type ?? 'unknown',
          createdAt: entry.createdAt ?? 0,
        }))
        .sort((a, b) => b.createdAt - a.createdAt),
    }
  }

  function entryOf(workflowId: string): FakeWorkflow {
    const entry = registry.get(workflowId)
    if (entry === undefined) throw new RillError('NOT_FOUND', `workflow not found: ${workflowId}`)
    return entry
  }

  function checked(method: MethodName, params: unknown): void {
    if (!Value.Check(METHODS[method].params, params)) throw new RillError('INVALID_PARAMS', `invalid ${method} params`)
  }

  function startRun(params: MethodParams<'startRun'>): MethodResult<'startRun'> {
    checked('startRun', params)
    const entry = entryOf(params.workflowId)
    runSerial += 1
    const runId = `run-fake-${String(runSerial).padStart(4, '0')}`
    const dryRun = params.dryRun ?? false
    const at = Date.now()
    inFlight.set(runId, params.workflowId)
    base.emit({ type: 'trigger.fired', at, workflowId: params.workflowId, runId })
    const actions = entry.workflow.nodes.filter((node) => !isTrigger(node.type))
    const failAt = control.runOutcome === 'failed' ? actions.length - 1 : -1
    const events: EngineEvent[] = [{ type: 'run.started', at, runId, workflowId: params.workflowId, dryRun }]
    let failedNode: string | undefined
    for (const [index, node] of actions.entries()) {
      if (failedNode !== undefined) {
        events.push({ type: 'step.skipped', at, runId, nodeId: node.id })
        continue
      }
      events.push({ type: 'step.started', at, runId, nodeId: node.id, attempt: 1 })
      if (index === failAt) {
        failedNode = node.id
        events.push({ type: 'step.failed', at, runId, nodeId: node.id, attempt: 1, error: failureText(node.id), willRetry: false })
      } else {
        events.push({ type: 'step.succeeded', at, runId, nodeId: node.id, attempt: 1 })
      }
    }
    events.push({ type: 'run.finished', at, runId, status: failedNode === undefined ? 'succeeded' : 'failed', error: failedNode === undefined ? null : failureText(failedNode) })
    base.play(runId, events, (fn, ms) => void setTimeout(fn, ms), control.stepIntervalMs)
    return { runId }
  }

  function setActive(params: { workflowId: string }, active: boolean): MethodResult<'activate'> {
    const entry = entryOf(params.workflowId)
    if (active && (control.activationError || entry.workflow.nodes.some((node) => node.type === 'trigger.manual@1'))) {
      throw new RillError('ACTIVATION_FAILED', 'the trigger could not be started')
    }
    entry.active = active
    base.emit({ type: active ? 'workflow.activated' : 'workflow.deactivated', at: Date.now(), workflowId: params.workflowId })
    return {}
  }

  function deleteWorkflow(params: MethodParams<'deleteWorkflow'>): MethodResult<'deleteWorkflow'> {
    checked('deleteWorkflow', params)
    entryOf(params.workflowId)
    if ([...inFlight.values()].includes(params.workflowId)) throw new RillError('WORKFLOW_BUSY', 'the workflow has a run that is queued or running')
    registry.delete(params.workflowId)
    base.emit({ type: 'workflow.deleted', at: Date.now(), workflowId: params.workflowId })
    return {}
  }

  async function request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    calls.push({ method, params })
    switch (method) {
      case 'ping':
        return { time: Date.now() } as MethodResult<M>
      case 'llmModels':
        return modelsFor(await host.settings.get()) as MethodResult<M>
      case 'listWorkflows':
        return listWorkflows() as MethodResult<M>
      case 'getWorkflow':
        return { workflow: structuredClone(entryOf((params as MethodParams<'getWorkflow'>).workflowId).workflow) } as MethodResult<M>
      case 'startRun':
        return startRun(params as MethodParams<'startRun'>) as MethodResult<M>
      case 'activate':
        checked('activate', params)
        return setActive(params as MethodParams<'activate'>, true) as MethodResult<M>
      case 'deactivate':
        checked('deactivate', params)
        return setActive(params as MethodParams<'deactivate'>, false) as MethodResult<M>
      case 'deleteWorkflow':
        return deleteWorkflow(params as MethodParams<'deleteWorkflow'>) as MethodResult<M>
      case 'plan': {
        const answer = (await inner.request(method, params)) as MethodResult<'plan'>
        if (answer.result.kind === 'workflow') plans.set(answer.planId, answer.result.workflow)
        return answer as MethodResult<M>
      }
      case 'deployPlan': {
        const answer = (await inner.request(method, params)) as MethodResult<'deployPlan'>
        const workflow = plans.get((params as MethodParams<'deployPlan'>).planId)
        if (workflow !== undefined) register(answer.workflowId, workflow)
        base.emit({ type: 'plan.deployed', at: Date.now(), workflowId: answer.workflowId, planId: (params as MethodParams<'deployPlan'>).planId })
        return answer as MethodResult<M>
      }
      case 'deploy': {
        const answer = (await inner.request(method, params)) as MethodResult<'deploy'>
        register(answer.workflowId, (params as MethodParams<'deploy'>).workflow as Workflow)
        return answer as MethodResult<M>
      }
      default:
        return inner.request(method, params)
    }
  }

  const client: FakeWorld['client'] = { request, onEvent: (listener) => base.onEvent(listener), emit: (event) => base.emit(event) }
  const connect: ConnectFn = async () => ({ request: client.request, onEvent: client.onEvent }) satisfies ConnectedClient

  return {
    host,
    client,
    connect,
    control,
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method),
    workflowIds: () => [...registry.keys()],
  }
}
