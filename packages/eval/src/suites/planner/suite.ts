import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmProvider, LlmRequest } from '@rill/llm'
import { createCoreRegistry, type NodeRegistry } from '@rill/nodes-core'
import { PlanError, createPlanner, type PlanEffort, type PlanResult, type Planner, type PlannerDeps } from '@rill/planner'
import { PRICE_TABLE_AS_OF } from '../../pricing'
import { summarizeRequest, type SentRequest } from '../../sent'
import type { RunContext, Suite } from '../../suite'
import { ATTACHMENTS_DIR, ATTACHMENTS_MANIFEST_FILE, createMemoryStore, resolveAttachments, type ResolveOptions, type ResolvedAttachment } from './attachments'
import { DEFAULT_MAX_REPAIR_ROUNDS, baseInputTokens, effortMaxTokens, firstCallInputTokens, isMeasurableEffort, plannerWorstCaseUsd, unmeasurableEffortMessage } from './budget'
import { loadPlannerData, toPlannerCase, type PlannerCase, type PlannerData } from './cases'
import { buildPlanRequest, withDemoHome } from './context'
import { serializablePlanError } from './error-json'
import { PLANNER_FIELDS, PLANNER_SCORER_VERSION, scorePlannerCase, type PlannerOutput } from './scoring'

export const PLANNER_SUITE_NAME = 'planner'
export const PLANNER_SUITE_NUMBER = 1

const VERSION_HASH_LENGTH = 12

export interface PlannerFactoryInput {
  deps: PlannerDeps
  ctx: RunContext
  testCase: PlannerCase
}

export type PlannerFactory = (input: PlannerFactoryInput) => Planner

export interface PlannerSuiteOptions {
  makePlanner?: PlannerFactory
  only?: string | readonly string[]
  group?: string | readonly string[]
  effort?: PlanEffort
  maxRepairRounds?: number
  registry?: NodeRegistry
  data?: PlannerData
  files?: ResolveOptions
}

export interface PlannerSuite extends Suite<PlannerCase, PlannerOutput> {
  baseInputTokens: number
  maxRepairRounds: number
  effort: PlanEffort | undefined
  workflowCases(): PlannerCase[]
}

const sentRequests = new WeakMap<object, SentRequest>()

export function plannerSentRequestOf(output: PlannerOutput): SentRequest | undefined {
  return sentRequests.get(output)
}

export function plannerVersions(effort: PlanEffort | undefined, maxRepairRounds: number): Record<string, string> {
  return {
    suite: String(PLANNER_SUITE_NUMBER),
    scorer: PLANNER_SCORER_VERSION,
    price_table: PRICE_TABLE_AS_OF,
    effort: effort ?? 'per case',
    max_repair_rounds: String(maxRepairRounds),
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex').slice(0, VERSION_HASH_LENGTH)
}

function select(cases: readonly PlannerCase[], options: PlannerSuiteOptions): PlannerCase[] {
  let picked = [...cases]
  if (options.group !== undefined) {
    const groups = typeof options.group === 'string' ? [options.group] : options.group
    const known = new Set(cases.map((testCase) => testCase.group))
    const unknown = groups.filter((group) => !known.has(group))
    if (unknown.length > 0) throw new Error(`unknown group: ${unknown.join(', ')}; groups are ${[...known].join(', ')}`)
    picked = picked.filter((testCase) => groups.includes(testCase.group))
  }
  const only = options.only
  if (only === undefined) return picked
  const ids = cases.map((testCase) => testCase.id)
  if (typeof only !== 'string') {
    const unknown = only.filter((id) => !ids.includes(id))
    if (unknown.length > 0) throw new Error(`unknown case id: ${unknown.join(', ')}`)
    return picked.filter((testCase) => only.includes(testCase.id))
  }
  const exact = picked.filter((testCase) => testCase.id === only)
  const found = exact.length > 0 ? exact : picked.filter((testCase) => testCase.id.includes(only))
  if (found.length === 0) throw new Error(`no case id contains "${only}"`)
  return found
}

function tapProvider(provider: LlmProvider, onRequest: (request: LlmRequest) => void): LlmProvider {
  return {
    name: provider.name,
    generate: (request, options) => {
      onRequest(request)
      return provider.generate(request, options)
    },
  }
}

export function createPlannerSuite(options: PlannerSuiteOptions = {}): PlannerSuite {
  const data = options.data ?? loadPlannerData()
  const registry = options.registry ?? createCoreRegistry()
  const makePlanner: PlannerFactory = options.makePlanner ?? (({ deps }) => createPlanner(deps))
  const maxRepairRounds = options.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS
  const baseTokens = baseInputTokens(registry)
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0) throw new RangeError('maxRepairRounds must be a non-negative integer')
  const all = data.cases.map((spec) => toPlannerCase(spec, data.references))
  const cases = select(all, options)
  const effortOf = (testCase: PlannerCase): PlanEffort => options.effort ?? testCase.spec.effort
  const unmeasurable = [...new Set([...(options.effort === undefined ? [] : [options.effort]), ...cases.map(effortOf)].filter((effort) => !isMeasurableEffort(effort)))]
  if (unmeasurable.length > 0) throw new RangeError(unmeasurableEffortMessage(unmeasurable))
  const attachmentCache = new Map<string, ResolvedAttachment[]>()
  const attachmentsOf = (testCase: PlannerCase): ResolvedAttachment[] => {
    const known = attachmentCache.get(testCase.id)
    if (known !== undefined) return known
    const resolved = resolveAttachments(testCase.spec, options.files)
    attachmentCache.set(testCase.id, resolved)
    return resolved
  }
  const readOptional = (path: string): Uint8Array => {
    try {
      return readFileSync(path)
    } catch {
      return new Uint8Array()
    }
  }
  const version = [
    `${PLANNER_SUITE_NUMBER}.${PLANNER_SCORER_VERSION}`,
    `p${PRICE_TABLE_AS_OF.replace(/-/gu, '')}`,
    sha256(JSON.stringify(data.cases)),
    sha256(JSON.stringify(data.references)),
    sha256(readOptional(join(options.files?.plannerDir ?? ATTACHMENTS_DIR, ATTACHMENTS_MANIFEST_FILE))),
  ].join('-')

  return {
    name: PLANNER_SUITE_NAME,
    version,
    baseInputTokens: baseTokens,
    maxRepairRounds,
    effort: options.effort,
    fields: PLANNER_FIELDS,
    cases: () => cases,
    workflowCases: () => cases.filter((testCase) => testCase.expected.outcome === 'workflow'),
    run: async (testCase, ctx) => {
      const files = attachmentsOf(testCase)
      let first: LlmRequest | undefined
      const provider = tapProvider(ctx.provider, (request) => {
        first ??= request
      })
      const deps: PlannerDeps = { provider, registry, attachmentStore: createMemoryStore(files), maxRepairRounds }
      const planner = makePlanner({ deps, ctx, testCase })
      const request = { ...buildPlanRequest(testCase.spec, files.map((file) => file.ref), options.effort), signal: ctx.signal }
      let output: PlanResult | PlanError
      try {
        output = await withDemoHome(() => planner.plan(request))
      } catch (error) {
        if (!(error instanceof PlanError) || error.kind !== 'invalid_after_repair') throw error
        output = serializablePlanError(error)
      }
      if (first !== undefined) sentRequests.set(output, summarizeRequest(first))
      return output
    },
    score: (testCase, output) => scorePlannerCase(testCase, output),
    estimateInputTokens: (testCase) => firstCallInputTokens(testCase.spec, attachmentsOf(testCase), baseTokens),
    worstCaseUsd: (testCase, model) =>
      plannerWorstCaseUsd(model, firstCallInputTokens(testCase.spec, attachmentsOf(testCase), baseTokens), maxRepairRounds, effortMaxTokens(effortOf(testCase))),
  }
}
