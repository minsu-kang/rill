import { LlmError, capabilitiesOf, type LlmPart, type LlmProvider, type LlmResult, type LlmUsage } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import { buildAgentPrompt } from '../agent'
import { defaultRandomHex } from '../attachments/prepare'
import type { RandomHex } from '../attachments/prepare'
import { SOFT_CAP_HEADROOM, resolveEffort } from '../capabilities'
import { addUsage, upperBoundCost } from '../plan'
import { ANSWER_PROBLEMS, checkAnswer, explainSchema } from './answer'
import { buildRunDigest } from './digest'
import { EXPLAIN_BUDGETS, EXPLAIN_RULES, repairText, userText, type ExplainEffort } from './prompt'
import { MAX_EXPLANATION_CHARS, MAX_REQUEST_CHARS, clampChars, createAnswerScrubber } from './scrub'
import { failureSignals } from './signals'
import { ExplainError, type ExplainAnswer, type ExplainResult, type ExplainRunInput } from './types'

const HEX_TAG = /^[0-9a-f]{12}$/
const MAX_CALLS = 2
const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

export const EXPLAIN_ERROR_TEXT = {
  provider: 'the model provider failed',
  unsupported: 'the model provider cannot return structured output',
  invalid: 'the model did not return a usable explanation',
  aborted: 'the explanation was cancelled',
} as const

export interface ExplainerDeps {
  provider: LlmProvider
  registry: NodeRegistry
  randomHex?: RandomHex
}

export type ExplainRequest = ExplainRunInput & { effort?: ExplainEffort; signal?: AbortSignal }

export interface Explainer {
  explain(input: ExplainRequest): Promise<ExplainResult>
}

function newTag(randomHex: RandomHex): string {
  const hex = randomHex(6)
  if (!HEX_TAG.test(hex)) throw new Error('randomHex must return 12 lowercase hex characters')
  return `run-data-${hex}`
}

export function createExplainer(deps: ExplainerDeps): Explainer {
  const { provider, registry } = deps
  const randomHex = deps.randomHex ?? defaultRandomHex
  return {
    explain: async (input) => {
      const capabilities = capabilitiesOf(provider)
      if (capabilities.structuredOutput !== 'strict' && capabilities.structuredOutput !== 'best-effort') {
        throw new ExplainError('provider', EXPLAIN_ERROR_TEXT.unsupported)
      }
      const requested = input.effort ?? 'low'
      if (!Object.hasOwn(EXPLAIN_BUDGETS, requested)) throw new RangeError('effort must be low, medium or high')
      const resolved = resolveEffort(capabilities, requested)
      const budget = EXPLAIN_BUDGETS[resolved.effective as ExplainEffort] ?? EXPLAIN_BUDGETS.high
      const timeoutMs = capabilities.reasoningCappedByMaxTokens ? budget.timeoutMs : budget.timeoutMs * SOFT_CAP_HEADROOM
      const tag = newTag(randomHex)
      const agentText = buildAgentPrompt(input.agent, randomHex).text
      const system = agentText === '' ? [{ text: EXPLAIN_RULES }] : [{ text: EXPLAIN_RULES }, { text: agentText }]
      const digest = buildRunDigest({ ...input, registry })
      const dataText = digest.text.replace(new RegExp(`</?${tag}>?`, 'gi'), '<hidden>')
      const signals = failureSignals(input.steps, registry, input.workflow)
      const scrubber = createAnswerScrubber({ workflow: input.workflow, registry, digestText: digest.text })
      const nodeIds = new Set(input.workflow.nodes.map((node) => node.id))
      const first = userText(tag, signals, dataText)

      let usage = ZERO
      let cost: number | null = 0
      let model = ''
      const spend = (result: Pick<LlmResult, 'model' | 'usage' | 'servedModels'>): void => {
        usage = addUsage(usage, result.usage)
        const price = upperBoundCost(result)
        cost = cost === null || price === undefined ? null : cost + price
        model = result.model
      }
      const spendUnreadable = (error: LlmError): void => {
        if (error.usage === undefined) {
          cost = null
          return
        }
        usage = addUsage(usage, error.usage)
        const price = error.model === undefined ? undefined : upperBoundCost({ model: error.model, usage: error.usage, ...(error.servedModels === undefined ? {} : { servedModels: error.servedModels }) })
        cost = cost === null || price === undefined ? null : cost + price
      }
      const isAborted = (): boolean => input.signal?.aborted === true
      const aborted = (cause?: unknown): ExplainError => new ExplainError('aborted', EXPLAIN_ERROR_TEXT.aborted, cause === undefined ? undefined : { cause })

      const finish = (answer: ExplainAnswer, repaired: boolean): ExplainResult => {
        const proposal = answer.fixProposal
        const requestText = proposal === undefined || !nodeIds.has(proposal.nodeId) ? undefined : clampChars(scrubber.requestText(proposal.requestText), MAX_REQUEST_CHARS)
        return {
          explanation: clampChars(scrubber.explanation(answer.explanation), MAX_EXPLANATION_CHARS),
          likelyCause: answer.likelyCause,
          suggestedActions: [...answer.suggestedActions],
          ...(proposal === undefined || requestText === undefined || requestText === '' ? {} : { fixProposal: { nodeId: proposal.nodeId, requestText } }),
          signals,
          meta: {
            provider: provider.name,
            model,
            effort: { requested, ...resolved },
            digestChars: dataText.length,
            truncated: digest.truncated,
            usage,
            costUsd: cost,
            repaired,
          },
        }
      }

      let content: string | LlmPart[] = first
      for (let call = 1; ; call++) {
        if (isAborted()) throw aborted(input.signal?.reason)
        let problems: string[]
        try {
          const result = await provider.generate(
            { system, messages: [{ role: 'user', content }], schema: explainSchema(), maxTokens: budget.maxTokens, effort: resolved.effective },
            { timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }) },
          )
          spend(result)
          const checked = checkAnswer(result.data)
          if (checked.answer !== undefined) return finish(checked.answer, call > 1)
          problems = checked.problems
        } catch (error) {
          if (error instanceof LlmError && error.kind === 'invalid_output') {
            spendUnreadable(error)
            problems = [ANSWER_PROBLEMS.notObject]
          } else if ((error instanceof LlmError && error.kind === 'aborted') || isAborted()) {
            throw aborted(error)
          } else {
            throw new ExplainError('provider', EXPLAIN_ERROR_TEXT.provider, { cause: error })
          }
        }
        if (call >= MAX_CALLS) throw new ExplainError('invalid', EXPLAIN_ERROR_TEXT.invalid)
        content = [
          { type: 'text', text: first },
          { type: 'text', text: repairText(problems) },
        ]
      }
    },
  }
}
