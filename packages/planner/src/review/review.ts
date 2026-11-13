import { LlmError, capabilitiesOf, type LlmPart, type LlmProvider, type LlmResult, type LlmUsage } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import { buildAgentPrompt } from '../agent'
import { defaultRandomHex, type RandomHex } from '../attachments/prepare'
import { SOFT_CAP_HEADROOM, SOFT_CAP_NOTE, resolveEffort } from '../capabilities'
import { repairText } from '../explain/prompt'
import { clampChars, createAnswerScrubber } from '../explain/scrub'
import { addUsage, upperBoundCost } from '../plan'
import { MAX_REVIEW_TEXT_CHARS, REVIEW_ANSWER_PROBLEMS, checkReview, reviewSchema } from './answer'
import { DEFAULT_REVIEW_EFFORT, REVIEW_BLOCKS, REVIEW_BUDGETS, REVIEW_RULES, reviewBlockTexts, reviewUserText, type ReviewBlock, type ReviewBlockTexts } from './prompt'
import { REVIEW_SEVERITIES, ReviewError, type ReviewAnswer, type ReviewEffort, type ReviewRequest, type ReviewResult } from './types'

const HEX_TAG = /^[0-9a-f]{12}$/
const MAX_CALLS = 2
const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

export const REVIEW_ERROR_TEXT = {
  provider: 'the model provider failed',
  unsupported: 'the model provider cannot return structured output',
  invalid: 'the model did not return a usable review',
  aborted: 'the review was cancelled',
} as const

export interface ReviewerDeps {
  provider: LlmProvider
  registry: NodeRegistry
  randomHex?: RandomHex
}

export interface Reviewer {
  review(input: ReviewRequest): Promise<ReviewResult>
}

function newTag(randomHex: RandomHex, block: ReviewBlock): string {
  const hex = randomHex(6)
  if (!HEX_TAG.test(hex)) throw new Error('randomHex must return 12 lowercase hex characters')
  return `review-${block}-${hex}`
}

export function createReviewer(deps: ReviewerDeps): Reviewer {
  const { provider, registry } = deps
  const randomHex = deps.randomHex ?? defaultRandomHex
  return {
    review: async (input) => {
      const capabilities = capabilitiesOf(provider)
      if (capabilities.structuredOutput !== 'strict' && capabilities.structuredOutput !== 'best-effort') {
        throw new ReviewError('provider', REVIEW_ERROR_TEXT.unsupported)
      }
      const requested = input.effort ?? DEFAULT_REVIEW_EFFORT
      if (!Object.hasOwn(REVIEW_BUDGETS, requested)) throw new RangeError('effort must be low, medium or high')
      const resolved = resolveEffort(capabilities, requested)
      const budget = REVIEW_BUDGETS[resolved.effective as ReviewEffort] ?? REVIEW_BUDGETS.high
      const timeoutMs = capabilities.reasoningCappedByMaxTokens ? budget.timeoutMs : budget.timeoutMs * SOFT_CAP_HEADROOM
      const blocks = reviewBlockTexts(input, registry)
      const tags: Partial<Record<ReviewBlock, string>> = {}
      for (const name of REVIEW_BLOCKS) if (blocks[name] !== undefined) tags[name] = newTag(randomHex, name)
      const agentPrompt = buildAgentPrompt(input.agent, randomHex, 'review')
      const system = agentPrompt.text === '' ? [{ text: REVIEW_RULES }] : [{ text: REVIEW_RULES }, { text: agentPrompt.text }]
      const tagPattern = new RegExp(`</?(?:${Object.values(tags).join('|')})>?`, 'gi')
      const safe = Object.fromEntries(Object.entries(blocks).map(([name, text]) => [name, text.replace(tagPattern, '<hidden>')])) as ReviewBlockTexts
      const first = reviewUserText(tags, safe)
      const scrubber = createAnswerScrubber({
        workflow: input.workflow,
        registry,
        digestText: [input.requestText, blocks.rules ?? ''].join('\n'),
        extraText: [input.requestText, ...(blocks.rules === undefined ? [] : [blocks.rules])],
      })
      const nodeIds = new Set(input.workflow.nodes.map((node) => node.id))

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
      const aborted = (cause?: unknown): ReviewError => new ReviewError('aborted', REVIEW_ERROR_TEXT.aborted, cause === undefined ? undefined : { cause })
      const scrub = (text: string): string => clampChars(scrubber.explanation(text), MAX_REVIEW_TEXT_CHARS)

      const finish = (answer: ReviewAnswer, repaired: boolean): ReviewResult => {
        const findings = answer.findings
          .map((finding) => ({
            severity: finding.severity,
            text: scrub(finding.text),
            ...(finding.nodeId !== undefined && nodeIds.has(finding.nodeId) ? { nodeId: finding.nodeId } : {}),
          }))
          .sort((a, b) => REVIEW_SEVERITIES.indexOf(a.severity) - REVIEW_SEVERITIES.indexOf(b.severity))
        return {
          review: { summary: scrub(answer.summary), findings },
          meta: {
            provider: provider.name,
            model,
            effort: { requested, ...resolved },
            ...(capabilities.reasoningCappedByMaxTokens ? {} : { costNote: SOFT_CAP_NOTE }),
            usage,
            costUsd: cost,
            repaired,
            agentUsed: { id: input.agent.id, name: input.agent.name },
            skillsUsed: agentPrompt.used ? (agentPrompt.skills ?? 0) : 0,
            agentDropped: agentPrompt.dropped,
          },
        }
      }

      let content: string | LlmPart[] = first
      for (let call = 1; ; call++) {
        if (isAborted()) throw aborted(input.signal?.reason)
        let problems: string[]
        try {
          const result = await provider.generate(
            { system, messages: [{ role: 'user', content }], schema: reviewSchema(), maxTokens: budget.maxTokens, effort: resolved.effective },
            { timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }) },
          )
          spend(result)
          const checked = checkReview(result.data)
          if (checked.answer !== undefined) return finish(checked.answer, call > 1)
          problems = checked.problems
        } catch (error) {
          if (error instanceof LlmError && error.kind === 'invalid_output') {
            spendUnreadable(error)
            problems = [REVIEW_ANSWER_PROBLEMS.notObject]
          } else if ((error instanceof LlmError && error.kind === 'aborted') || isAborted()) {
            throw aborted(error)
          } else {
            throw new ReviewError('provider', REVIEW_ERROR_TEXT.provider, { cause: error })
          }
        }
        if (call >= MAX_CALLS) throw new ReviewError('invalid', REVIEW_ERROR_TEXT.invalid)
        content = [
          { type: 'text', text: first },
          { type: 'text', text: repairText(problems) },
        ]
      }
    },
  }
}
