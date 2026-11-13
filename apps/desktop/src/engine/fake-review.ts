import {
  METHODS,
  RillError,
  type Agent,
  type LlmModelInfo,
  type MethodParams,
  type MethodResult,
  type PlanResultBody,
  type Review,
  type ReviewFinding,
  type ReviewMeta,
} from '@rill/protocol'
import Value from 'typebox/value'
import { findingOf, reviewMetaOf } from '../fixtures/review'
import type { FakeAgents } from './fake-agents'

export interface ReviewContext {
  agent: Agent
  nodeIds: string[]
}

export type ReviewOutcome = { review: Review; meta?: Partial<ReviewMeta> } | RillError | 'hang'
export type ReviewScript = (params: MethodParams<'reviewPlan'>, context: ReviewContext) => ReviewOutcome

export interface FakeReviewsEnv {
  plan(planId: string): PlanResultBody | undefined
  agents: Pick<FakeAgents, 'resolveReviewer'>
  model: LlmModelInfo | undefined
}

export interface FakeReviews {
  run(params: MethodParams<'reviewPlan'>, env: FakeReviewsEnv): Promise<MethodResult<'reviewPlan'>>
  running(): number
}

export interface FakeReviewsOptions {
  script?: ReviewScript
  delayMs?: number
}

const SEVERITY_ORDER: Readonly<Record<ReviewFinding['severity'], number>> = { problem: 0, warning: 1, info: 2 }

function defaultReview(nodeIds: readonly string[]): ReviewOutcome {
  const [, second, third] = nodeIds
  return {
    review: {
      summary: 'The plan follows the request. A few things are worth a second look before you deploy it.',
      findings: [
        findingOf('info', 'The settings use the folder you named in the request.'),
        findingOf('warning', 'No retry is set, so a short network error ends the run.', third ?? second),
        findingOf('problem', 'The step writes outside the folder named in the request. Check that this is the file you want to change.', second),
      ],
    },
  }
}

export function createFakeReviews(options: FakeReviewsOptions = {}): FakeReviews {
  let running = 0

  return {
    running: () => running,
    run(params, env) {
      const plan = env.plan(params.planId)
      if (plan === undefined) throw new RillError('NOT_FOUND', `plan not found: ${params.planId}`)
      if (plan.kind !== 'workflow') throw new RillError('PLAN_NOT_REVIEWABLE', 'only a plan that has a workflow can be reviewed')
      const agent = env.agents.resolveReviewer(params.agentId)
      if (env.model === undefined) throw new RillError('LLM_UNAVAILABLE', 'no model provider is configured for reviewing')
      if (running > 0) throw new RillError('REVIEW_BUSY', 'a review is already running')
      const nodeIds = plan.workflow.nodes.map((node) => node.id)
      const answer = (options.script ?? ((_params, context) => defaultReview(context.nodeIds)))(structuredClone(params), { agent: structuredClone(agent), nodeIds })
      running += 1
      return new Promise((resolve, reject) => {
        const settle = (): void => {
          running -= 1
        }
        if (answer === 'hang') return
        const finish = (): void => {
          settle()
          if (answer instanceof RillError) {
            reject(answer)
            return
          }
          const known = new Set(nodeIds)
          const findings = answer.review.findings
            .map(({ nodeId, ...rest }): ReviewFinding => (nodeId === undefined || !known.has(nodeId) ? rest : { ...rest, nodeId }))
            .map((finding, index) => ({ finding, index }))
            .sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.index - b.index)
            .map((entry) => entry.finding)
          const effort = params.effort ?? 'medium'
          const model = env.model!
          const result = {
            review: { summary: answer.review.summary, findings },
            meta: reviewMetaOf({
              provider: model.provider,
              model: model.id,
              effort: { requested: effort, effective: effort, native: model.capabilities.effortMap[effort] ?? effort, collapsed: false },
              agentUsed: { id: agent.id, name: agent.name },
              skillsUsed: (agent.skillIds ?? []).length,
              ...answer.meta,
            }),
          }
          if (!Value.Check(METHODS.reviewPlan.result, result)) {
            reject(new RillError('INTERNAL', 'the fake reviewPlan answer does not match the protocol'))
            return
          }
          resolve(structuredClone(result))
        }
        if ((options.delayMs ?? 0) > 0) setTimeout(finish, options.delayMs)
        else queueMicrotask(finish)
      })
    },
  }
}
