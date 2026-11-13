import { REVIEW_MAX_FINDINGS, RillError, type MethodParams } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods, type FakePlanData } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { agentFixtures } from '../src/fixtures/agents'
import { memoryFixtures, models, modelsNothingConfigured, outcomeOf, results } from '../src/fixtures/plan'
import { findingOf, reviewCases } from '../src/fixtures/review'
import { skillFixtures } from '../src/fixtures/skills'

const planParams = (planId: string): MethodParams<'plan'> => ({ planId, text: 'wait', turns: [], attachments: [], effort: 'low' })

function make(extra: Partial<FakePlanData> = {}) {
  const data: FakePlanData = {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    agents: [...agentFixtures.few, ...agentFixtures.skilled, ...agentFixtures.reviewers],
    skills: skillFixtures.few,
    ...extra,
  }
  const client = withPlanMethods(createFakeClient(fakeData), data)
  return { client, request: client.request.bind(client) as typeof client.request }
}

async function failure(promise: Promise<unknown>): Promise<RillError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RillError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

describe('the fake engine answers reviewPlan with the errors of the engine, in its order', () => {
  it('refuses an unknown plan before it looks at the agent', async () => {
    const { request } = make()
    expect((await failure(request('reviewPlan', { planId: 'missing', agentId: 'agent-reviewer' }))).code).toBe('NOT_FOUND')
    expect((await failure(request('reviewPlan', { planId: 'missing', agentId: 'nobody' }))).code).toBe('NOT_FOUND')
  })

  it('refuses a plan that has no workflow before it looks at the agent', async () => {
    const { request } = make({ script: () => outcomeOf(results.questions) })
    await request('plan', planParams('q'))
    expect((await failure(request('reviewPlan', { planId: 'q', agentId: 'nobody' }))).code).toBe('PLAN_NOT_REVIEWABLE')
    const unsupported = make({ script: () => outcomeOf(results.unsupported) })
    await unsupported.request('plan', planParams('u'))
    expect((await failure(unsupported.request('reviewPlan', { planId: 'u', agentId: 'agent-reviewer' }))).code).toBe('PLAN_NOT_REVIEWABLE')
  })

  it('refuses a plan that failed before it looks at the agent, as the engine does for a failed record', async () => {
    const { request } = make({ script: () => new RillError('PLAN_PROVIDER', 'the provider failed') })
    expect((await failure(request('plan', planParams('f')))).code).toBe('PLAN_PROVIDER')
    expect((await failure(request('reviewPlan', { planId: 'f', agentId: 'nobody' }))).code).toBe('PLAN_NOT_REVIEWABLE')
    expect((await failure(request('reviewPlan', { planId: 'f', agentId: 'agent-reviewer' }))).code).toBe('PLAN_NOT_REVIEWABLE')
  })

  it('refuses a plan that was cancelled the same way, and keeps NOT_FOUND for an id that was never planned', async () => {
    const { client, request } = make({ script: () => 'hang' })
    const planning = request('plan', planParams('c'))
    const rejected = failure(planning)
    client.request('cancelPlan', { planId: 'c' })
    expect((await rejected).code).toBe('PLAN_CANCELLED')
    expect((await failure(request('reviewPlan', { planId: 'c', agentId: 'agent-reviewer' }))).code).toBe('PLAN_NOT_REVIEWABLE')
    expect((await failure(request('reviewPlan', { planId: 'never', agentId: 'agent-reviewer' }))).code).toBe('NOT_FOUND')
  })

  it('reviews a plan again when a retry under the same id made a workflow', async () => {
    let calls = 0
    const { request } = make({ script: () => (calls++ === 0 ? new RillError('PLAN_PROVIDER', 'x') : outcomeOf(results.workflow)) })
    await failure(request('plan', planParams('r')))
    expect((await failure(request('reviewPlan', { planId: 'r', agentId: 'agent-reviewer' }))).code).toBe('PLAN_NOT_REVIEWABLE')
    await request('plan', planParams('r'))
    expect((await request('reviewPlan', { planId: 'r', agentId: 'agent-reviewer' })).review.summary).not.toBe('')
  })

  it('refuses an unknown agent, an assistant and the built-in agent, in that order of meaning', async () => {
    const { request } = make()
    await request('plan', planParams('p'))
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'nobody' }))).code).toBe('AGENT_NOT_FOUND')
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-terse' }))).code).toBe('AGENT_NOT_REVIEWER')
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'default' }))).code).toBe('AGENT_NOT_REVIEWER')
  })

  it('refuses with LLM_UNAVAILABLE when no model is active, after the agent checks', async () => {
    const { request } = make({ models: modelsNothingConfigured })
    await request('plan', planParams('p'))
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'nobody' }))).code).toBe('AGENT_NOT_FOUND')
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' }))).code).toBe('LLM_UNAVAILABLE')
  })

  it('refuses a second review while one runs, and takes one again when it ended', async () => {
    const { request } = make({ delayMs: 20 })
    const first = request('plan', planParams('a'))
    const second = request('plan', planParams('b'))
    await Promise.all([first, second])
    const running = request('reviewPlan', { planId: 'a', agentId: 'agent-reviewer' })
    expect((await failure(request('reviewPlan', { planId: 'b', agentId: 'agent-reviewer' }))).code).toBe('REVIEW_BUSY')
    await running
    expect((await request('reviewPlan', { planId: 'b', agentId: 'agent-reviewer' })).review.summary).not.toBe('')
  })

  it('checks the params with the protocol schema', async () => {
    const { request } = make()
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer', effort: 'xhigh' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer', extra: 1 } as never))).code).toBe('INVALID_PARAMS')
  })
})

describe('the fake engine answers reviewPlan with a scripted result', () => {
  it('returns the review and a meta that names the reviewer, the provider and the skills', async () => {
    const { request } = make({ review: () => ({ review: reviewCases.mixed }) })
    await request('plan', planParams('p'))
    const result = await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer', effort: 'high' })
    expect(result.review.summary).toBe(reviewCases.mixed.summary)
    expect(result.meta).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      agentUsed: { id: 'agent-reviewer', name: 'Safety reviewer' },
      skillsUsed: 1,
      agentDropped: 0,
      repaired: false,
      effort: { requested: 'high', effective: 'high' },
    })
  })

  it('counts the skills of the reviewer that exist, and none for a reviewer without skills', async () => {
    const { request } = make()
    await request('plan', planParams('p'))
    expect((await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer-ko' })).meta).toMatchObject({ skillsUsed: 0, agentUsed: { name: '꼼꼼한 검토자' } })
  })

  it('passes the plan and the reviewer to the script and lets it override the meta', async () => {
    const seen: Array<{ agent: string; nodes: string[] }> = []
    const { request } = make({
      review: (_params, context) => {
        seen.push({ agent: context.agent.id, nodes: context.nodeIds })
        return { review: reviewCases.clean, meta: { costNote: 'A note about the price.', costUsd: null, repaired: true } }
      },
    })
    await request('plan', planParams('p'))
    const result = await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })
    expect(seen).toEqual([{ agent: 'agent-reviewer', nodes: ['watch', 'extract', 'append'] }])
    expect(result.meta).toMatchObject({ costNote: 'A note about the price.', costUsd: null, repaired: true })
  })

  it('orders the findings by severity and keeps the order given inside one severity', async () => {
    const { request } = make({
      review: () => ({ review: { summary: 's', findings: [findingOf('info', 'i1'), findingOf('problem', 'p1'), findingOf('warning', 'w1'), findingOf('problem', 'p2'), findingOf('info', 'i2')] } }),
    })
    await request('plan', planParams('p'))
    expect((await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })).review.findings.map((finding) => finding.text)).toEqual(['p1', 'p2', 'w1', 'i1', 'i2'])
  })

  it('drops a node id that the workflow does not have and keeps the text', async () => {
    const { request } = make({ review: () => ({ review: { summary: 's', findings: [findingOf('warning', 'text', 'ghost'), findingOf('warning', 'real', 'extract')] } }) })
    await request('plan', planParams('p'))
    const { findings } = (await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })).review
    expect(findings).toEqual([{ severity: 'warning', text: 'text' }, { severity: 'warning', text: 'real', nodeId: 'extract' }])
  })

  it('has a default result that shows every severity when nothing is scripted', async () => {
    const { request } = make()
    await request('plan', planParams('p'))
    const { review } = await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })
    expect(new Set(review.findings.map((finding) => finding.severity))).toEqual(new Set(['problem', 'warning', 'info']))
    expect(review.findings.length).toBeLessThanOrEqual(REVIEW_MAX_FINDINGS)
  })

  it('fails with the error that the script gives, and a failed review takes no place afterwards', async () => {
    let calls = 0
    const { request } = make({
      review: () => {
        calls += 1
        return calls === 1 ? new RillError('REVIEW_PROVIDER', 'x') : { review: reviewCases.clean }
      },
    })
    await request('plan', planParams('p'))
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' }))).code).toBe('REVIEW_PROVIDER')
    expect((await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })).review.findings).toEqual([])
  })

  it('can be told to hang, and then holds its place', async () => {
    const { request } = make({ review: () => 'hang' })
    await request('plan', planParams('p'))
    void request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })
    await Promise.resolve()
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' }))).code).toBe('REVIEW_BUSY')
  })

  it('refuses an answer of the script that does not match the protocol', async () => {
    const { request } = make({ review: () => ({ review: { summary: '', findings: [] } }) })
    await request('plan', planParams('p'))
    expect((await failure(request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' }))).code).toBe('INTERNAL')
  })
})

describe('a review changes nothing', () => {
  it('leaves the plan deployable with the same flags, and the agents and skills as they were', async () => {
    const { request, client } = make({ script: () => outcomeOf(results.flagged) })
    await request('plan', planParams('p'))
    const before = JSON.stringify([await request('listAgents', {}), await request('listSkills', {})])
    await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })
    expect(JSON.stringify([await request('listAgents', {}), await request('listSkills', {})])).toBe(before)
    expect((await failure(request('deployPlan', { planId: 'p', confirmed: [] }))).code).toBe('PLAN_NOT_CONFIRMED')
    const flags = results.flagged.kind === 'workflow' ? results.flagged.flags : []
    const keys = flags.map((flag) => `${flag.nodeId}|${flag.code}|${flag.pointer}`)
    expect(keys).toHaveLength(3)
    expect(client.pendingPlans()).toEqual([])
  })

  it('can review a deployed plan, because the engine can', async () => {
    const { request } = make()
    await request('plan', planParams('p'))
    await request('deployPlan', { planId: 'p', confirmed: [] })
    expect((await request('reviewPlan', { planId: 'p', agentId: 'agent-reviewer' })).review.summary).not.toBe('')
  })
})
