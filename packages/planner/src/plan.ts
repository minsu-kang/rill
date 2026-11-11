import { capIssues, isWarningIssue, type PlanIssue, type Workflow } from '@rill/dsl'
import { LlmError, costUsd, type LlmMessage, type LlmPart, type LlmRequest, type LlmResult, type LlmUsage } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import { ATTACHMENT_RULES, attachmentModule } from './attachments'
import { fold } from './attachments/normalize'
import { createProvenanceCache, userSourcedTest } from './attachments/provenance'
import { maskConfig, unmaskConfig } from './mask'
import { convertSchema, restoreConverted } from './convert'
import { decodeGeneration, type DecodeContext, type Decoded } from './decode'
import { AttachmentError } from './errors'
import { generationSchema, type Envelope, type GenerationMode } from './generation'
import { hiddenValues, withoutHiddenFields } from './hidden'
import { MAX_ATTACHMENTS_PER_CONVERSATION, MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentModule, type Planner, type PlannerDeps, type ProvenanceInput } from './ports'
import {
  EFFORT_BUDGETS,
  assistantContent,
  currentTurnText,
  renderUserTurn,
  systemBlocks,
  targetedText,
  userMessage,
  type CurrentTurnInput,
} from './prompt'
import { MAX_QUESTION_TURNS, gapLanguage, gapQuestions, gapSummary, isGapIssue, isNoticeIssue, questionTurnsSinceLastWorkflow } from './questions'
import { PlanError, type Flag, type PlanRequest, type PlanResult, type PlanQuestion, type PlanResultBody, type PlanRound, type PlanTurn } from './types'

export const DEFAULT_MAX_REPAIR_ROUNDS = 3
export const MAX_TARGETED_NODES = 2

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  }
}

export function upperBoundCost(result: Pick<LlmResult, 'model' | 'usage' | 'servedModels'>): number | undefined {
  const models = [...new Set([result.model, ...(result.servedModels ?? [])])]
  const prices = models.map((model) => costUsd(model, result.usage))
  if (prices.some((price) => price === undefined)) return undefined
  return Math.max(...(prices as number[]))
}

export function repairMessage(round: number, issues: readonly PlanIssue[]): string {
  return JSON.stringify({ round, issues })
}

function isTargetCode(issue: PlanIssue): boolean {
  return issue.stage === 3 && issue.code.startsWith('config_')
}

export function targetNodes(errors: readonly PlanIssue[], workflow: Workflow | undefined): number[] | undefined {
  if (workflow === undefined || errors.length === 0) return undefined
  const indexes = new Set<number>()
  for (const issue of errors) {
    const match = /^\/nodes\/(\d+)\/config(\/|$)/.exec(issue.pointer)
    if (!isTargetCode(issue) || match === null) return undefined
    indexes.add(Number(match[1]))
  }
  if (indexes.size > MAX_TARGETED_NODES) return undefined
  return [...indexes].sort((a, b) => a - b)
}

interface Classified {
  errors: PlanIssue[]
  gaps: PlanIssue[]
}

function classify(issues: readonly PlanIssue[], request: PlanRequest, workflow: Workflow | undefined): Classified {
  const errors: PlanIssue[] = []
  const gaps: PlanIssue[] = []
  for (const issue of issues) {
    if (isWarningIssue(issue) || isNoticeIssue(issue)) continue
    if (isGapIssue(issue, request.context, workflow)) gaps.push(issue)
    else errors.push(issue)
  }
  return { errors, gaps }
}

const MIN_CONTAINED_OPTION = 3

function questionsBefore(turns: readonly PlanTurn[], index: number): PlanQuestion[] {
  for (let i = index - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (turn.role === 'assistant') return turn.result?.kind === 'questions' ? turn.result.questions : []
  }
  return []
}

/** An answer that is, or contains, an option the model offered comes from the model, not from the user. */
export function answerFromOptions(answer: string, options: readonly string[]): boolean {
  const value = fold(answer.trim())
  return options
    .map((option) => fold(option.trim()))
    .some((option) => option !== '' && (value === option || (option.length >= MIN_CONTAINED_OPTION && value.includes(option))))
}

/** The texts the user wrote: the turn texts, free-text answers and the current request; never a chosen option. */
export function userTexts(request: PlanRequest): string[] {
  const texts: string[] = []
  request.turns.forEach((turn, index) => {
    if (turn.role !== 'user') return
    const asked = questionsBefore(request.turns, index)
    const answers = Object.entries(turn.answers ?? {})
      .filter(([id, answer]) => {
        const question = asked.find((candidate) => candidate.id === id)
        return !answerFromOptions(answer, question === undefined ? asked.flatMap((candidate) => candidate.options) : question.options)
      })
      .map(([, answer]) => answer)
    texts.push(turn.text, ...answers)
  })
  texts.push(request.text)
  return texts.filter((text) => text.trim() !== '')
}

class Run {
  private readonly rounds: PlanRound[] = []
  private readonly attachments: AttachmentModule
  private readonly registry: NodeRegistry
  private readonly mode: GenerationMode
  private readonly allowQuestions: boolean
  private readonly ctx: DecodeContext
  private attachmentTexts: string[] = []
  private readonly provenanceCache = createProvenanceCache()
  private totalUsage: LlmUsage = ZERO
  private cost: number | null = 0
  private lastModel = ''
  private fallbackUsed = false
  private lastIssues: PlanIssue[] = []

  constructor(
    private readonly deps: PlannerDeps,
    private readonly request: PlanRequest,
  ) {
    this.attachments = deps.attachments ?? attachmentModule
    this.registry = deps.registry
    this.mode = request.selection === undefined ? 'create' : 'patch'
    this.allowQuestions = questionTurnsSinceLastWorkflow(request.turns) < MAX_QUESTION_TURNS
    this.ctx = {
      registry: deps.registry,
      context: request.context,
      mode: this.mode,
      allowQuestions: this.allowQuestions,
      ...(request.selection === undefined ? {} : { selection: request.selection.nodeId }),
    }
  }

  private fail(kind: PlanError['kind'], message: string, cause?: unknown): PlanError {
    return new PlanError(kind, message, [...this.rounds], this.lastIssues, cause === undefined ? undefined : { cause })
  }

  private checkAbort(): void {
    if (this.request.signal?.aborted === true) throw this.fail('aborted', 'planning was aborted', this.request.signal.reason)
  }

  private checkRequest(): void {
    const { selection, context } = this.request
    if (selection === undefined) return
    const existing = context.existingWorkflow
    const problem =
      existing === undefined
        ? { code: 'selection_without_workflow', message: 'a selection needs context.existingWorkflow' }
        : existing.nodes.some((node) => node.id === selection.nodeId)
          ? undefined
          : { code: 'selection_unknown_node', message: `the selected node ${selection.nodeId} is not in the existing workflow` }
    if (problem === undefined) return
    this.lastIssues = [{ stage: 1, pointer: '/selection/nodeId', ...problem }]
    throw this.fail('invalid_request', problem.message)
  }

  private checkAttachmentLimits(): void {
    const current = this.request.attachments.length
    if (current > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw this.fail('attachment', `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message, got ${current}`)
    }
    const earlier = this.request.turns.reduce((sum, turn) => sum + (turn.role === 'user' ? (turn.attachments?.length ?? 0) : 0), 0)
    if (earlier + current > MAX_ATTACHMENTS_PER_CONVERSATION) {
      throw this.fail('attachment', `at most ${MAX_ATTACHMENTS_PER_CONVERSATION} attachments per conversation, got ${earlier + current}`)
    }
  }

  private async prepare(refs: PlanTurn['attachments'], cacheLast: boolean): Promise<LlmPart[]> {
    if (refs === undefined || refs.length === 0) return []
    const store = this.deps.attachmentStore
    if (store === undefined) throw this.fail('attachment', 'attachments were given but the planner has no attachment store')
    try {
      const prepared = await this.attachments.prepare({ store, refs, cacheLast })
      this.attachmentTexts.push(...prepared.texts)
      return prepared.parts
    } catch (error) {
      if (error instanceof AttachmentError) throw this.fail('attachment', error.message, error)
      throw error
    }
  }

  private turnInput(): CurrentTurnInput {
    return { request: this.request, patchMode: this.mode === 'patch', questionTurns: questionTurnsSinceLastWorkflow(this.request.turns) }
  }

  private async messages(): Promise<LlmMessage[]> {
    const { turns } = this.request
    const lastWithAttachments = turns.reduce((last, turn, i) => (turn.role === 'user' && (turn.attachments?.length ?? 0) > 0 ? i : last), -1)
    const messages: LlmMessage[] = []
    for (const [index, turn] of turns.entries()) {
      if (turn.role === 'assistant') {
        messages.push({ role: 'assistant', content: assistantContent(turn) })
        continue
      }
      const parts = await this.prepare(turn.attachments, index === lastWithAttachments)
      messages.push(userMessage(renderUserTurn(turn), parts))
    }
    const parts = await this.prepare(this.request.attachments, false)
    messages.push(userMessage(currentTurnText(this.turnInput()), parts))
    return messages
  }

  private hasAttachments(): boolean {
    return this.request.attachments.length > 0 || this.request.turns.some((turn) => (turn.attachments?.length ?? 0) > 0)
  }

  private async call(request: LlmRequest): Promise<LlmResult | LlmError> {
    const budget = EFFORT_BUDGETS[this.request.effort]
    try {
      const result = await this.deps.provider.generate(request, {
        timeoutMs: budget.timeoutMs,
        ...(this.request.signal === undefined ? {} : { signal: this.request.signal }),
      })
      this.record(result)
      return result
    } catch (error) {
      if (error instanceof LlmError) {
        if (error.kind === 'aborted') throw this.fail('aborted', 'planning was aborted', error)
        if (error.kind === 'invalid_output') {
          this.recordUnreadable(error)
          return error
        }
        throw this.fail('provider', `the model provider failed: ${error.message}`, error)
      }
      if (this.request.signal?.aborted === true) throw this.fail('aborted', 'planning was aborted', error)
      throw error
    }
  }

  private record(result: LlmResult): void {
    this.totalUsage = addUsage(this.totalUsage, result.usage)
    const price = upperBoundCost(result)
    this.cost = this.cost === null || price === undefined ? null : this.cost + price
    this.lastModel = result.model
    this.fallbackUsed ||= result.fallbackUsed
  }

  private recordUnreadable(error: LlmError): void {
    const { usage, model, servedModels } = error
    if (usage === undefined) {
      this.cost = null
      return
    }
    this.totalUsage = addUsage(this.totalUsage, usage)
    const price = model === undefined ? undefined : upperBoundCost({ model, usage, ...(servedModels === undefined ? {} : { servedModels }) })
    this.cost = this.cost === null || price === undefined ? null : this.cost + price
  }

  private baseRequest(messages: LlmMessage[], schema: Record<string, unknown>): LlmRequest {
    return {
      system: systemBlocks(this.registry, this.hasAttachments() ? ATTACHMENT_RULES : undefined),
      messages,
      schema,
      maxTokens: EFFORT_BUDGETS[this.request.effort].maxTokens,
      effort: this.request.effort,
    }
  }

  private provenanceInput(): Omit<ProvenanceInput, 'workflow'> {
    const existing = this.request.context.existingWorkflow
    return {
      registry: this.registry,
      userTexts: userTexts(this.request),
      cache: this.provenanceCache,
      ...(existing === undefined ? {} : { existingWorkflow: existing }),
      attachmentTexts: this.attachmentTexts,
      trustedConnections: this.request.context.connections.map((connection) => connection.name),
      allowedRoots: this.request.context.allowedRoots,
    }
  }

  private flagsFor(workflow: Workflow | undefined): Flag[] {
    if (workflow === undefined) return []
    return this.attachments.provenance({ workflow, ...this.provenanceInput() })
  }

  private redact(issues: PlanIssue[], workflow: Workflow | undefined, flags: Flag[]): PlanIssue[] {
    return this.attachments.redactIssues(issues, {
      ...(workflow === undefined ? {} : { workflow }),
      registry: this.registry,
      attachmentTexts: this.attachmentTexts,
      flags,
    })
  }

  private finish(body: PlanResultBody): PlanResult {
    return {
      ...body,
      rounds: [...this.rounds],
      usage: this.totalUsage,
      costUsd: this.cost,
      model: this.lastModel,
      effort: this.request.effort,
      fallbackUsed: this.fallbackUsed,
    }
  }

  private async targeted(indexes: number[], decoded: Decoded, errors: PlanIssue[]): Promise<{ data: Envelope; issues: PlanIssue[] }> {
    const workflow = decoded.workflow!
    const envelope = structuredClone(decoded.envelope!)
    const issues: PlanIssue[] = []
    const flags = this.flagsFor(workflow)
    const userSourced = userSourcedTest(this.provenanceInput())
    for (const index of indexes) {
      this.checkAbort()
      const node = workflow.nodes[index]!
      const def = this.registry.get(node.type)!
      const pointer = `/nodes/${index}/config`
      const redacted = this.redact(
        errors.filter((issue) => issue.pointer === pointer || issue.pointer.startsWith(`${pointer}/`)),
        workflow,
        flags,
      )
      const visible = withoutHiddenFields(def)
      const hidden = hiddenValues(def, node.config)
      const own = Object.fromEntries(Object.entries(node.config).filter(([key]) => !Object.hasOwn(hidden, key)))
      const { shown, masked } = maskConfig(own, { def, nodePointer: pointer, flags, userSourced, attachmentTexts: this.attachmentTexts })
      const text = targetedText(this.request, userTexts(this.request), node, shown, redacted)
      const result = await this.call(this.baseRequest([{ role: 'user', content: text }], convertSchema(visible).schema))
      if (result instanceof LlmError) {
        this.roundUsage = addUsage(this.roundUsage, result.usage ?? ZERO)
        issues.push({ stage: 1, pointer, code: 'invalid_output', message: `targeted repair of node ${node.id}: ${result.message}` })
        continue
      }
      this.roundUsage = addUsage(this.roundUsage, result.usage)
      const restored = restoreConverted(visible, result.data, pointer)
      if (restored.issues.length > 0 || restored.value === null || typeof restored.value !== 'object' || Array.isArray(restored.value)) {
        issues.push(...(restored.issues.length > 0 ? restored.issues : [{ stage: 1 as const, pointer, code: 'config_json_parse', message: 'the repaired config is not an object' }]))
        continue
      }
      const config = JSON.stringify(unmaskConfig(restored.value, masked))
      if (this.mode === 'create') envelope.workflow!.nodes[index]!.config = config
      else envelope.patch = [...(envelope.patch ?? []), { op: 'set_config', nodeId: node.id, config }]
    }
    return { data: envelope, issues }
  }

  private roundUsage: LlmUsage = ZERO

  async run(): Promise<PlanResult> {
    this.checkAbort()
    this.checkRequest()
    this.checkAttachmentLimits()
    const messages = await this.messages()
    const maxRepairRounds = this.deps.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS
    let previous: unknown
    let targets: number[] | undefined
    let last: { decoded: Decoded; errors: PlanIssue[] } | undefined
    for (let index = 0; ; index++) {
      this.checkAbort()
      const started = Date.now()
      this.roundUsage = ZERO
      let decoded: Decoded
      let extra: PlanIssue[] = []
      let targeted: string[] = []
      if (targets !== undefined && last !== undefined) {
        targeted = targets.map((i) => last!.decoded.workflow!.nodes[i]!.id)
        const repaired = await this.targeted(targets, last.decoded, last.errors)
        extra = repaired.issues
        previous = repaired.data
        decoded = decodeGeneration(repaired.data, this.ctx)
      } else {
        const schema = this.schema()
        const result = await this.call(this.baseRequest(messages, schema))
        if (result instanceof LlmError) {
          this.roundUsage = result.usage ?? ZERO
          previous = undefined
          decoded = { issues: [{ stage: 1, pointer: '', code: 'invalid_output', message: `the answer could not be read: ${result.message}`, hint: 'answer with one JSON object that matches the output schema' }] }
        } else {
          this.roundUsage = result.usage
          previous = result.data
          decoded = decodeGeneration(result.data, this.ctx)
        }
      }
      const issues = [...extra, ...decoded.issues]
      const { errors, gaps } = classify(issues, this.request, decoded.workflow)
      const flags = this.flagsFor(decoded.workflow)
      const recorded = this.redact(capIssues(issues), decoded.workflow, flags)
      this.rounds.push({ index, issues: recorded, usage: this.roundUsage, durationMs: Date.now() - started, targeted })
      if (errors.length === 0 && decoded.body !== undefined) {
        this.lastIssues = []
        return this.finish(this.complete(decoded.body, gaps, decoded.workflow, flags))
      }
      const sent = this.redact(capIssues(errors.length > 0 ? errors : issues), decoded.workflow, flags)
      this.lastIssues = sent
      if (index >= maxRepairRounds) {
        throw this.fail('invalid_after_repair', `no valid answer after ${maxRepairRounds} repair rounds`)
      }
      targets = targetNodes(errors, decoded.workflow)
      if (targets !== undefined && decoded.envelope !== undefined) {
        last = { decoded, errors }
        continue
      }
      targets = undefined
      last = undefined
      this.appendRepair(messages, previous, repairMessage(index + 1, sent))
    }
  }

  private schema(): Record<string, unknown> {
    return generationSchema(this.registry, { mode: this.mode, allowQuestions: this.allowQuestions })
  }

  private appendRepair(messages: LlmMessage[], previous: unknown, text: string): void {
    if (previous !== undefined) {
      messages.push({ role: 'assistant', content: JSON.stringify(previous) }, { role: 'user', content: text })
      return
    }
    const lastMessage = messages[messages.length - 1]!
    const parts: LlmPart[] = typeof lastMessage.content === 'string' ? [{ type: 'text', text: lastMessage.content }] : [...lastMessage.content]
    messages[messages.length - 1] = { role: 'user', content: [...parts, { type: 'text', text }] }
  }

  private complete(body: PlanResultBody, gaps: PlanIssue[], workflow: Workflow | undefined, flags: Flag[]): PlanResultBody {
    const language = gapLanguage([this.request.text, ...this.request.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text)].join('\n'))
    if (gaps.length > 0 && this.allowQuestions) {
      const asked = gapQuestions(gaps, workflow, language)
      return { kind: 'questions', questions: asked.questions, summary: asked.summary }
    }
    if (body.kind !== 'workflow') return body
    if (gaps.length > 0) return { ...body, summary: gapSummary(body.summary, gaps, workflow, language), flags, needsConfirmation: true }
    return { ...body, flags, needsConfirmation: flags.length > 0 || body.needsConfirmation }
  }
}

export function createPlanner(deps: PlannerDeps): Planner {
  return {
    plan: (request) => new Run(deps, request).run(),
  }
}
