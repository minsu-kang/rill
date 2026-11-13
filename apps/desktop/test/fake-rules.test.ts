import { RULE_MAX_ITEMS, RillError, type Rule } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods, type FakePlanData } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, metaOf, models, outcomeOf, results } from '../src/fixtures/plan'
import type { RuleViolation } from '../src/model/rules'

function make(extra: Partial<FakePlanData> = {}) {
  const data: FakePlanData = { models, script: () => outcomeOf(results.workflow), memory: [...memoryFixtures.three], ...extra }
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
  throw new Error('the call did not fail')
}

describe('the fake engine answers the rule methods with the rules of the engine', () => {
  it('starts with no rule and lists the rules it was given, oldest first', async () => {
    expect((await make().request('listRules', {})).rules).toEqual([])
    const seeded: Rule[] = [
      { id: 'r1', kind: 'forbidNode', value: 'delay', createdAt: 1 },
      { id: 'r2', kind: 'allowHost', value: 'api.example.com', createdAt: 2 },
    ]
    expect((await make({ rules: seeded }).request('listRules', {})).rules).toEqual(seeded)
  })

  it('saves a forbidden node, stores the spelling of the catalog and gives an id and a time', async () => {
    const { request } = make({ now: () => 5000 })
    const { rule } = await request('saveRule', { kind: 'forbidNode', value: '  HTTP.request ' })
    expect(rule).toMatchObject({ kind: 'forbidNode', value: 'http.request', createdAt: 5000 })
    expect(rule.id).not.toBe('')
    expect((await request('listRules', {})).rules).toEqual([rule])
  })

  it('knows the node types of the catalog without their versions', async () => {
    const { request } = make()
    expect((await failure(request('saveRule', { kind: 'forbidNode', value: 'http.request@1' }))).problems[0]).toMatch(/^unknown_node_type: /)
    expect((await failure(request('saveRule', { kind: 'forbidNode', value: 'no.such.node' }))).code).toBe('RULE_INVALID')
  })

  it('saves a host in its normal form', async () => {
    const { request } = make()
    expect((await request('saveRule', { kind: 'allowHost', value: 'API.Example.COM' })).rule.value).toBe('api.example.com')
    expect((await request('saveRule', { kind: 'allowHost', value: '*.Example.com' })).rule.value).toBe('*.example.com')
    expect((await request('saveRule', { kind: 'allowHost', value: 'münchen.de' })).rule.value).toBe('xn--mnchen-3ya.de')
  })

  it('refuses a bad value with RULE_INVALID, the name of the rule and never the value', async () => {
    const { request } = make()
    const cases: Array<[string, string]> = [
      ['https://secret.example.com', 'host_scheme'],
      ['secret.example.com/path', 'host_path'],
      ['secret.example.com:8080', 'host_port'],
      ['user@secret.example.com', 'host_user_info'],
      ['sec ret.example.com', 'host_space'],
      ['secret..example.com', 'host_empty_label'],
      ['*', 'host_wildcard'],
      ['', 'empty'],
      ['a\u202eb.example.com', 'bidi_format'],
    ]
    for (const [value, rule] of cases) {
      const error = await failure(request('saveRule', { kind: 'allowHost', value }))
      expect(error.code).toBe('RULE_INVALID')
      expect(error.problems).toHaveLength(1)
      expect(error.problems[0]).toMatch(new RegExp(`^${rule}: `))
      expect(error.problems[0]).not.toContain('secret')
      expect(error.message).not.toContain('secret')
    }
  })

  it('takes the planning effort cap by name and refuses another name', async () => {
    const { request } = make()
    expect((await request('saveRule', { kind: 'maxPlanEffort', value: ' High ' })).rule.value).toBe('high')
    const error = await failure(request('saveRule', { kind: 'maxPlanEffort', value: 'ultra' }))
    expect(error.problems[0]).toMatch(/^unknown_effort: /)
  })

  it('has at most one cap: saving it again replaces it, keeps its id, and is no duplicate', async () => {
    const { request } = make()
    const first = (await request('saveRule', { kind: 'maxPlanEffort', value: 'high' })).rule
    const second = (await request('saveRule', { kind: 'maxPlanEffort', value: 'low' })).rule
    expect(second).toMatchObject({ id: first.id, value: 'low', createdAt: first.createdAt })
    expect((await request('saveRule', { kind: 'maxPlanEffort', value: 'low' })).rule.id).toBe(first.id)
    expect((await request('listRules', {})).rules).toHaveLength(1)
  })

  it('refuses the same kind and value again as RULE_DUPLICATE, also in another spelling', async () => {
    const { request } = make()
    await request('saveRule', { kind: 'allowHost', value: 'api.example.com' })
    expect((await failure(request('saveRule', { kind: 'allowHost', value: 'API.EXAMPLE.COM' }))).code).toBe('RULE_DUPLICATE')
    await request('saveRule', { kind: 'forbidNode', value: 'delay' })
    expect((await failure(request('saveRule', { kind: 'forbidNode', value: 'DELAY' }))).code).toBe('RULE_DUPLICATE')
    await request('saveRule', { kind: 'allowHost', value: 'delay' })
  })

  it('stops at 30 rules with RULE_FULL, but still replaces the cap', async () => {
    const seeded: Rule[] = [
      { id: 'cap', kind: 'maxPlanEffort', value: 'high', createdAt: 1 },
      ...Array.from({ length: RULE_MAX_ITEMS - 1 }, (_, index): Rule => ({ id: `h${index}`, kind: 'allowHost', value: `h${index}.example.com`, createdAt: 2 + index })),
    ]
    const { request } = make({ rules: seeded })
    expect((await failure(request('saveRule', { kind: 'allowHost', value: 'one-more.example.com' }))).code).toBe('RULE_FULL')
    expect((await failure(request('saveRule', { kind: 'allowHost', value: 'h0.example.com' }))).code).toBe('RULE_DUPLICATE')
    expect((await request('saveRule', { kind: 'maxPlanEffort', value: 'low' })).rule.value).toBe('low')
  })

  it('deletes a rule and answers RULE_NOT_FOUND for an id that is not there', async () => {
    const { request } = make()
    const { rule } = await request('saveRule', { kind: 'forbidNode', value: 'delay' })
    expect(await request('deleteRule', { id: rule.id })).toEqual({ deleted: true })
    expect((await request('listRules', {})).rules).toEqual([])
    expect((await failure(request('deleteRule', { id: rule.id }))).code).toBe('RULE_NOT_FOUND')
  })

  it('checks the parameters with the schema of the protocol', async () => {
    const { request } = make()
    expect((await failure(request('saveRule', { kind: 'nope', value: 'x' } as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(request('saveRule', { kind: 'allowHost', value: 'x'.repeat(501) }))).code).toBe('INVALID_PARAMS')
    expect((await failure(request('deleteRule', {} as never))).code).toBe('INVALID_PARAMS')
    expect((await failure(request('listRules', { extra: 1 } as never))).code).toBe('INVALID_PARAMS')
  })

  it('answers checkRules with the scripted violations, and none by default', async () => {
    expect((await make().request('checkRules', {})).violations).toEqual([])
    const scripted = [{ workflowId: 'wf-1', name: 'Receipts', issues: [{ stage: 3 as const, pointer: '/nodes/1/type', code: 'rule_violation', message: 'node n1: the node type delay is forbidden by the rules' }] }]
    const { request } = make({ violations: () => scripted })
    expect((await request('checkRules', {})).violations).toEqual(scripted)
  })

  it('stops at 200 workflows and 20 issues for each, as the engine does', async () => {
    const issue = (index: number) => ({ stage: 3 as const, pointer: `/nodes/${index}/type`, code: 'rule_violation', message: `node n${index}: the node type delay is forbidden by the rules` })
    const many: RuleViolation[] = Array.from({ length: 250 }, (_, index) => ({ workflowId: `wf-${index}`, name: `Workflow ${index}`, issues: Array.from({ length: 25 }, (_, at) => issue(at)) }))
    const { violations } = await make({ violations: () => many }).request('checkRules', {})
    expect(violations).toHaveLength(200)
    expect(violations.every((entry) => entry.issues.length === 20)).toBe(true)
    expect(violations[199]!.workflowId).toBe('wf-199')
    const few = await make({ violations: () => many.slice(0, 3) }).request('checkRules', {})
    expect(few.violations).toHaveLength(3)
  })

  it('gives the scripted violations the rules at the moment of the call', async () => {
    const seen: string[][] = []
    const { request } = make({
      violations: (rules) => {
        seen.push(rules.map((rule) => rule.value))
        return []
      },
    })
    await request('saveRule', { kind: 'forbidNode', value: 'delay' })
    await request('checkRules', {})
    expect(seen).toEqual([['delay']])
  })
})

describe('the fake planner and the cap', () => {
  const asked = { planId: 'p-1', text: 'watch a folder', turns: [], attachments: [] }

  it('lowers a request above the cap to the cap and says so in the meta', async () => {
    const { request } = make({ script: () => outcomeOf(results.workflow, metaOf({ effort: 'xhigh', effortDetail: { requested: 'xhigh', effective: 'xhigh', native: 'xhigh', collapsed: false, cappedByRule: false } })) })
    await request('saveRule', { kind: 'maxPlanEffort', value: 'medium' })
    const answer = await request('plan', { ...asked, effort: 'xhigh' })
    expect(answer.meta.effort).toBe('medium')
    expect(answer.meta.effortDetail).toMatchObject({ requested: 'xhigh', effective: 'medium', native: 'medium', collapsed: true, cappedByRule: true })
  })

  it('lowers the cap to a step the active model has, as the planner does, and says it collapsed', async () => {
    const muse = { ...models, active: { provider: 'meta' as const, model: 'muse-spark-1.0' } }
    const { request } = make({ models: muse })
    await request('saveRule', { kind: 'maxPlanEffort', value: 'high' })
    const answer = await request('plan', { ...asked, effort: 'xhigh' })
    expect(answer.meta.effort).toBe('medium')
    expect(answer.meta.effortDetail).toMatchObject({ requested: 'xhigh', effective: 'medium', native: 'medium', collapsed: true, cappedByRule: true })
  })

  it('keeps the cap itself when the active model has that step, and when no model is active', async () => {
    const haiku = { ...models, active: { provider: 'anthropic' as const, model: 'claude-haiku-5' } }
    const first = make({ models: haiku })
    await first.request('saveRule', { kind: 'maxPlanEffort', value: 'high' })
    expect((await first.request('plan', { ...asked, effort: 'max' })).meta.effortDetail).toMatchObject({ effective: 'high', collapsed: true, cappedByRule: true })
    const second = make({ models: { ...models, active: null } })
    await second.request('saveRule', { kind: 'maxPlanEffort', value: 'low' })
    expect((await second.request('plan', { ...asked, effort: 'high' })).meta.effortDetail).toMatchObject({ effective: 'low', cappedByRule: true })
  })

  it('leaves a request at or below the cap alone', async () => {
    const { request } = make()
    await request('saveRule', { kind: 'maxPlanEffort', value: 'high' })
    const answer = await request('plan', { ...asked, planId: 'p-2', effort: 'high' })
    expect(answer.meta.effortDetail?.cappedByRule).toBe(false)
    const lower = await request('plan', { ...asked, planId: 'p-3', effort: 'low' })
    expect(lower.meta.effortDetail?.cappedByRule).toBe(false)
  })

  it('does not touch the meta without a cap', async () => {
    const { request } = make()
    const answer = await request('plan', { ...asked, effort: 'max' })
    expect(answer.meta.effortDetail?.cappedByRule).toBe(false)
  })
})
