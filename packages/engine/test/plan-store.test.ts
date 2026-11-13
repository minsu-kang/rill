import type { Workflow } from '@rill/dsl'
import { flagKey, type AttachmentRef, type PlanMeta, type PlanResultBody } from '@rill/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import {
  PlanDeployedError,
  PlanExistsError,
  PlanNotFoundError,
  confirmationProblem,
  plannedRecord,
  workflowHash,
  type StoredPlan,
} from '../src/plans'
import { Store } from '../src/store'

const workflow: Workflow = {
  schemaVersion: 1,
  name: 'demo',
  nodes: [
    { id: 't1', type: 'trigger.manual@1', config: {} },
    { id: 'n1', type: 'notify.slack@1', config: { connection: 'team', text: 'hi', nested: { b: 1, a: [1, 2] } } },
  ],
  edges: [{ from: 't1', to: 'n1' }],
}

const flag = { nodeId: 'n1', pointer: '/connection', code: 'new_egress_target' as const, message: 'new target' }
const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }

const meta: PlanMeta = {
  rounds: [{ index: 0, issues: [{ stage: 3, pointer: '/nodes/1/config', code: 'config_required', message: 'm', hint: 'h' }], usage, durationMs: 9, targeted: ['n1'] }],
  usage,
  costUsd: 0.25,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  fallbackUsed: false,
}

const ref: AttachmentRef = { id: 'att-00001', mediaType: 'application/pdf', name: 'receipt.pdf', bytes: 42 }

function workflowResult(flags = [flag]): PlanResultBody {
  return { kind: 'workflow', workflow, summary: 'sends a message', flags, needsConfirmation: flags.length > 0 }
}

function plan(overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    planId: 'plan-1',
    createdAt: 1000,
    status: 'planned',
    effort: 'high',
    model: 'claude-sonnet-5-5',
    requestText: 'send a slack message',
    attachments: [ref],
    result: workflowResult(),
    meta,
    error: null,
    flagKeys: [JSON.stringify(['n1', '/connection', 'new_egress_target'])],
    workflowId: null,
    confirmed: null,
    memoryIds: [],
    workflowHash: workflowHash(workflow),
    ...overrides,
  }
}

let db: Db
let store: Store

beforeEach(() => {
  db = Db.open(':memory:')
  store = new Store(db)
})

describe('plan records', () => {
  it('round-trips every field of a planned record', () => {
    const saved = plan()
    store.savePlan(saved)
    expect(store.getPlan('plan-1')).toEqual(saved)
  })

  it('round-trips the memory ids, in order, and stores an empty list for a record without them', () => {
    const used = plan({ planId: 'used-1', memoryIds: ['note-b', 'note-a'] })
    const bare = plan({ planId: 'bare-1' })
    delete bare.memoryIds
    store.savePlan(used)
    store.savePlan(bare)
    expect(store.getPlan('used-1').memoryIds).toEqual(['note-b', 'note-a'])
    expect(store.getPlan('bare-1').memoryIds).toEqual([])
    expect(db.get<{ memory_ids: string }>('SELECT memory_ids FROM plans WHERE id = ?', 'used-1')?.memory_ids).toBe('["note-b","note-a"]')
  })

  it('round-trips failed and cancelled records without a result', () => {
    const failed = plan({ planId: 'failed-1', status: 'failed', model: null, result: null, meta: null, error: 'the plan was not valid', flagKeys: [], workflowHash: null })
    const cancelled = plan({ planId: 'cancel-1', status: 'cancelled', result: null, meta, error: 'planning was aborted', flagKeys: [], workflowHash: null })
    store.savePlan(failed)
    store.savePlan(cancelled)
    expect(store.getPlan('failed-1')).toEqual(failed)
    expect(store.getPlan('cancel-1')).toEqual(cancelled)
  })

  it('round-trips question and unsupported results', () => {
    const questions = plan({
      planId: 'q-1',
      result: { kind: 'questions', questions: [{ id: 'q1', text: 'Which folder?', options: ['A'], default: 'A' }], summary: 'asks' },
      flagKeys: [],
      workflowHash: null,
    })
    const unsupported = plan({
      planId: 'u-1',
      result: { kind: 'unsupported', reason: 'no node', nearest: 'http.request@1', summary: 'cannot' },
      flagKeys: [],
      workflowHash: null,
    })
    store.savePlan(questions)
    store.savePlan(unsupported)
    expect(store.getPlan('q-1')).toEqual(questions)
    expect(store.getPlan('u-1')).toEqual(unsupported)
  })

  it('keeps the request text, the effort and the confirmed keys of a deployed plan', () => {
    const id = store.saveWorkflow(workflow)
    store.savePlan(plan({ requestText: 'multi\nline "quoted" text', effort: 'max' }))
    store.markPlanDeployed('plan-1', id, ['k1', 'k2'])
    expect(store.getPlan('plan-1')).toMatchObject({
      requestText: 'multi\nline "quoted" text',
      effort: 'max',
      workflowId: id,
      confirmed: ['k1', 'k2'],
    })
  })

  it('rejects a duplicate id and keeps the first record', () => {
    store.savePlan(plan())
    expect(() => store.savePlan(plan({ requestText: 'other' }))).toThrow(PlanExistsError)
    expect(store.getPlan('plan-1').requestText).toBe('send a slack message')
  })

  it('throws PlanNotFoundError for an unknown id', () => {
    expect(() => store.getPlan('missing')).toThrow(PlanNotFoundError)
    expect(() => store.getPlan('missing')).toThrow('plan not found: missing')
  })

  it('rejects an unknown status through the table check', () => {
    expect(() => store.savePlan(plan({ status: 'running' as never }))).toThrow()
  })
})

describe('attachment refs', () => {
  it('stores the four ref fields and drops anything else it is handed', () => {
    const MARKER = 'ATTACHMENT-MARKER-7f3a'
    const dirty = { ...ref, text: `${MARKER} contents`, data: MARKER, nested: { MARKER } } as unknown as AttachmentRef
    store.savePlan(plan({ attachments: [dirty] }))
    expect(store.getPlan('plan-1').attachments).toEqual([ref])
    const raw = db.get<{ attachments: string }>('SELECT attachments FROM plans WHERE id = ?', 'plan-1')!
    expect(JSON.parse(raw.attachments)).toEqual([ref])
    expect(raw.attachments).not.toContain(MARKER)
    const everything = JSON.stringify(db.all('SELECT * FROM plans'))
    expect(everything).not.toContain(MARKER)
  })

  it('keeps several refs in order', () => {
    const second: AttachmentRef = { id: 'att-00002', mediaType: 'image/png', name: 'photo.png', bytes: 7 }
    store.savePlan(plan({ attachments: [ref, second] }))
    expect(store.getPlan('plan-1').attachments).toEqual([ref, second])
  })
})

describe('listPlanSummaries', () => {
  it('lists the newest first, breaks ties by insertion order and honours the limit', () => {
    store.savePlan(plan({ planId: 'a', createdAt: 100, flagKeys: [], workflowHash: null }))
    store.savePlan(plan({ planId: 'b', createdAt: 300, flagKeys: [], workflowHash: null }))
    store.savePlan(plan({ planId: 'c', createdAt: 300, flagKeys: [], workflowHash: null }))
    store.savePlan(plan({ planId: 'd', createdAt: 200, flagKeys: [], workflowHash: null }))
    expect(store.listPlanSummaries(10).map((p) => p.planId)).toEqual(['c', 'b', 'd', 'a'])
    expect(store.listPlanSummaries(2).map((p) => p.planId)).toEqual(['c', 'b'])
    expect(store.listPlanSummaries(1).map((p) => p.planId)).toEqual(['c'])
  })

  it('summarises each kind of record', () => {
    const id = store.saveWorkflow(workflow)
    store.savePlan(plan({ planId: 'w', createdAt: 1 }))
    store.markPlanDeployed('w', id, [JSON.stringify(['n1', '/connection', 'new_egress_target'])])
    store.savePlan(
      plan({
        planId: 'q',
        createdAt: 2,
        result: { kind: 'questions', questions: [], summary: 'asks' },
        flagKeys: [],
        workflowHash: null,
      }),
    )
    store.savePlan(
      plan({
        planId: 'u',
        createdAt: 3,
        result: { kind: 'unsupported', reason: 'r', nearest: 'n', summary: 'cannot' },
        flagKeys: [],
        workflowHash: null,
      }),
    )
    store.savePlan(plan({ planId: 'f', createdAt: 4, status: 'failed', result: null, meta: null, error: 'x', flagKeys: [], workflowHash: null }))
    store.savePlan(plan({ planId: 'm', createdAt: 5, flagKeys: ['k1', 'k2'] }))
    const byId = Object.fromEntries(store.listPlanSummaries(10).map((s) => [s.planId, s]))
    expect(byId['w']).toEqual({ planId: 'w', createdAt: 1, status: 'planned', kind: 'workflow', summary: 'sends a message', flagCount: 1, workflowId: id })
    expect(byId['q']).toEqual({ planId: 'q', createdAt: 2, status: 'planned', kind: 'questions', summary: 'asks', flagCount: 0, workflowId: null })
    expect(byId['u']).toEqual({ planId: 'u', createdAt: 3, status: 'planned', kind: 'unsupported', summary: 'cannot', flagCount: 0, workflowId: null })
    expect(byId['f']).toEqual({ planId: 'f', createdAt: 4, status: 'failed', kind: null, summary: null, flagCount: 0, workflowId: null })
    expect(byId['m']?.flagCount).toBe(2)
  })

  it('does not carry the workflow, the attachments or the hash', () => {
    store.savePlan(plan())
    const summary = store.listPlanSummaries(5)[0]!
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'flagCount', 'kind', 'planId', 'status', 'summary', 'workflowId'])
  })
})

describe('markPlanDeployed', () => {
  it('sets the workflow id and the confirmed keys together', () => {
    const id = store.saveWorkflow(workflow)
    store.savePlan(plan())
    store.markPlanDeployed('plan-1', id, ['a'])
    const row = db.get<{ workflow_id: string; confirmed: string }>('SELECT workflow_id, confirmed FROM plans WHERE id = ?', 'plan-1')!
    expect(row.workflow_id).toBe(id)
    expect(JSON.parse(row.confirmed)).toEqual(['a'])
  })

  it('stores an empty confirmed list as a list, not as null', () => {
    const id = store.saveWorkflow(workflow)
    store.savePlan(plan({ flagKeys: [], workflowHash: null }))
    store.markPlanDeployed('plan-1', id, [])
    expect(store.getPlan('plan-1').confirmed).toEqual([])
  })

  it('refuses an unknown plan and a plan that is already deployed', () => {
    const id = store.saveWorkflow(workflow)
    expect(() => store.markPlanDeployed('missing', id, [])).toThrow(PlanNotFoundError)
    store.savePlan(plan())
    store.markPlanDeployed('plan-1', id, ['a'])
    expect(() => store.markPlanDeployed('plan-1', id, ['b'])).toThrow(PlanDeployedError)
    expect(store.getPlan('plan-1').confirmed).toEqual(['a'])
  })

  it('leaves the plan untouched when the workflow does not exist', () => {
    store.savePlan(plan())
    expect(() => store.markPlanDeployed('plan-1', 'no-such-workflow', ['a'])).toThrow()
    expect(store.getPlan('plan-1')).toMatchObject({ workflowId: null, confirmed: null })
  })
})

describe('findOpenPlanByHash', () => {
  const hash = workflowHash(workflow)

  it('finds a flagged plan that has not been deployed', () => {
    store.savePlan(plan())
    expect(store.findOpenPlanByHash(hash)).toEqual({ id: 'plan-1' })
  })

  it('ignores plans with no flags', () => {
    store.savePlan(plan({ flagKeys: [] }))
    expect(store.findOpenPlanByHash(hash)).toBeUndefined()
  })

  it('ignores plans that are already deployed', () => {
    const id = store.saveWorkflow(workflow)
    store.savePlan(plan())
    store.markPlanDeployed('plan-1', id, ['a'])
    expect(store.findOpenPlanByHash(hash)).toBeUndefined()
  })

  it('ignores other hashes and plans without a hash', () => {
    store.savePlan(plan({ planId: 'other', workflowHash: workflowHash({ ...workflow, nodes: [workflow.nodes[0]!] }) }))
    store.savePlan(plan({ planId: 'none', status: 'failed', result: null, meta: null, workflowHash: null }))
    expect(store.findOpenPlanByHash(hash)).toBeUndefined()
  })

  it('returns the newest open plan', () => {
    store.savePlan(plan({ planId: 'old', createdAt: 1 }))
    store.savePlan(plan({ planId: 'new', createdAt: 2 }))
    store.savePlan(plan({ planId: 'tie', createdAt: 2 }))
    expect(store.findOpenPlanByHash(hash)).toEqual({ id: 'tie' })
  })
})

describe('workflowHash', () => {
  const hex = /^[0-9a-f]{64}$/

  it('is a sha256 hex digest and is stable', () => {
    expect(workflowHash(workflow)).toMatch(hex)
    expect(workflowHash(workflow)).toBe(workflowHash(structuredClone(workflow)))
  })

  it('ignores key order at every depth', () => {
    const reordered = {
      edges: [{ to: 'n1', from: 't1' }],
      nodes: [
        { config: {}, type: 'trigger.manual@1', id: 't1' },
        { id: 'n1', config: { nested: { a: [1, 2], b: 1 }, text: 'hi', connection: 'team' }, type: 'notify.slack@1' },
      ],
      name: 'demo',
      schemaVersion: 1,
    }
    expect(workflowHash(reordered)).toBe(workflowHash(workflow))
  })

  it('ignores the name', () => {
    expect(workflowHash({ ...workflow, name: 'something else entirely' })).toBe(workflowHash(workflow))
  })

  it('treats undefined properties like absent ones', () => {
    const withUndefined = { ...workflow, edges: [{ from: 't1', to: 'n1', when: undefined }] }
    expect(workflowHash(withUndefined)).toBe(workflowHash(workflow))
  })

  it('changes with a config value, a type, a retry setting or an onError setting', () => {
    const base = workflowHash(workflow)
    const edit = (change: (copy: Workflow) => void) => {
      const copy = structuredClone(workflow)
      change(copy)
      return workflowHash(copy)
    }
    const variants = [
      edit((w) => {
        w.nodes[1]!.config.text = 'bye'
      }),
      edit((w) => {
        ;(w.nodes[1]!.config.nested as { b: number }).b = 2
      }),
      edit((w) => {
        w.nodes[1]!.config.extra = true
      }),
      edit((w) => {
        w.nodes[1]!.type = 'notify.slack@2'
      }),
      edit((w) => {
        w.nodes[1]!.id = 'n2'
        w.edges[0]!.to = 'n2'
      }),
      edit((w) => {
        w.nodes[1]!.retry = { maxAttempts: 3 }
      }),
      edit((w) => {
        w.nodes[1]!.onError = 'continue'
      }),
      edit((w) => {
        w.schemaVersion = 2 as never
      }),
    ]
    for (const variant of variants) expect(variant).not.toBe(base)
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1)
  })

  it('changes with an edge or a when condition', () => {
    const base = workflowHash(workflow)
    const noEdge = workflowHash({ ...workflow, edges: [] })
    const withWhen = workflowHash({ ...workflow, edges: [{ from: 't1', to: 'n1', when: 'yes' }] })
    const otherWhen = workflowHash({ ...workflow, edges: [{ from: 't1', to: 'n1', when: 'no' }] })
    expect(new Set([base, noEdge, withWhen, otherWhen]).size).toBe(4)
  })

  it('ignores the order of the nodes and of the edges', () => {
    const three: Workflow = {
      ...workflow,
      nodes: [...workflow.nodes, { id: 'n2', type: 'delay@1', config: { ms: 1 } }],
      edges: [
        { from: 't1', to: 'n1' },
        { from: 'n1', to: 'n2', when: 'yes' },
        { from: 'n1', to: 'n2', when: 'no' },
      ],
    }
    const shuffled = { ...three, nodes: [three.nodes[2]!, three.nodes[0]!, three.nodes[1]!], edges: [three.edges[2]!, three.edges[0]!, three.edges[1]!] }
    expect(workflowHash(shuffled)).toBe(workflowHash(three))
    expect(workflowHash({ ...three, nodes: [three.nodes[1]!, three.nodes[0]!, three.nodes[2]!] })).toBe(workflowHash(three))
  })

  it('orders the nodes by what they hold, not by properties that are undefined', () => {
    const node = (id: string, config: Record<string, unknown>) => ({ id, type: 'x@1', config })
    const withUndefined = { ...workflow, nodes: [node('a', { p: undefined }), node('b', { q: 1 })], edges: [] }
    const without = { ...workflow, nodes: [node('a', {}), node('b', { q: 1 })], edges: [] }
    expect(workflowHash(withUndefined)).toBe(workflowHash(without))
  })

  it('keeps nodes and edges apart that differ in anything but order', () => {
    const base = { ...workflow, nodes: [...workflow.nodes, { id: 'n2', type: 'delay@1', config: { ms: 1 } }], edges: [{ from: 't1', to: 'n1' }, { from: 'n1', to: 'n2' }] }
    const sameNodesOtherEdges = { ...base, edges: [{ from: 't1', to: 'n1' }, { from: 't1', to: 'n2' }] }
    const oneEdgeTwice = { ...base, edges: [{ from: 't1', to: 'n1' }, { from: 't1', to: 'n1' }] }
    const fewerNodes = { ...base, nodes: base.nodes.slice(0, 2), edges: [{ from: 't1', to: 'n1' }] }
    expect(new Set([base, sameNodesOtherEdges, oneEdgeTwice, fewerNodes].map(workflowHash)).size).toBe(4)
  })

  it('keeps the order of the arrays inside a config', () => {
    const rows = (row: unknown[]) => workflowHash({ ...workflow, nodes: [workflow.nodes[0]!, { id: 'n1', type: 'csv.append@1', config: { row } }] })
    expect(rows(['a', 'b'])).not.toBe(rows(['b', 'a']))
  })

  it('treats the defaults of onError and retry like absent settings', () => {
    const base = workflowHash(workflow)
    const withNode = (extra: Record<string, unknown>) => workflowHash({ ...workflow, nodes: [workflow.nodes[0]!, { ...workflow.nodes[1]!, ...extra }] })
    expect(withNode({ onError: 'fail' })).toBe(base)
    expect(withNode({ retry: { maxAttempts: 1 } })).toBe(base)
    expect(withNode({ retry: { maxAttempts: 1, baseDelayMs: 9000 } })).toBe(base)
    expect(withNode({ onError: 'fail', retry: { maxAttempts: 1 } })).toBe(base)
    expect(withNode({ retry: { maxAttempts: 3 } })).toBe(withNode({ retry: { maxAttempts: 3, baseDelayMs: 500 } }))
  })

  it('keeps a retry or an onError that changes what the node does', () => {
    const withNode = (extra: Record<string, unknown>) => workflowHash({ ...workflow, nodes: [workflow.nodes[0]!, { ...workflow.nodes[1]!, ...extra }] })
    const variants = [
      withNode({}),
      withNode({ onError: 'continue' }),
      withNode({ retry: { maxAttempts: 2 } }),
      withNode({ retry: { maxAttempts: 3 } }),
      withNode({ retry: { maxAttempts: 3, baseDelayMs: 100 } }),
      withNode({ retry: { maxAttempts: 3, baseDelayMs: 0 } }),
      withNode({ onError: 'continue', retry: { maxAttempts: 3 } }),
    ]
    expect(new Set(variants).size).toBe(variants.length)
  })

  it('does not confuse values that serialise alike', () => {
    const value = (v: unknown) => workflowHash({ ...workflow, nodes: [{ id: 't1', type: 'x@1', config: { v } }], edges: [] })
    expect(value('1')).not.toBe(value(1))
    expect(value(null)).not.toBe(value('null'))
    expect(value([])).not.toBe(value({}))
    expect(value({ a: 'b,"c":1' })).not.toBe(value({ a: 'b', c: 1 }))
  })

  it('does not throw on input that is not a workflow', () => {
    expect(workflowHash(null)).toMatch(hex)
    expect(workflowHash('text')).toMatch(hex)
    expect(workflowHash({})).toBe(workflowHash(null))
    expect(workflowHash({ nodes: 'x', edges: 5 })).toMatch(hex)
    expect(workflowHash({ nodes: [null, 'x', 3, { retry: 'x', onError: 7 }], edges: [null] })).toMatch(hex)
  })
})

describe('confirmationProblem', () => {
  const keys = (count: number) => Array.from({ length: count }, (_, index) => flagKey({ nodeId: `n${index}`, pointer: '/url', code: 'new_egress_target' }))
  const listed = (message: string | undefined) => (message?.match(/ at \/url/g) ?? []).length

  it('is satisfied by exactly the flag keys, in any order', () => {
    expect(confirmationProblem(keys(3), [...keys(3)].reverse())).toBeUndefined()
    expect(confirmationProblem([], [])).toBeUndefined()
  })

  it('names each missing flag by node and pointer', () => {
    const message = confirmationProblem(keys(2), [keys(2)[0]!])
    expect(message).toContain('not confirmed: n1 at /url')
    expect(message).not.toContain('n0')
  })

  it('lists at most 20 missing flags and counts the rest', () => {
    const twenty = confirmationProblem(keys(20), [])
    expect(listed(twenty)).toBe(20)
    expect(twenty).not.toContain('more')
    const twentyOne = confirmationProblem(keys(21), [])
    expect(listed(twentyOne)).toBe(20)
    expect(twentyOne).toContain('and 1 more')
    const twentyFive = confirmationProblem(keys(25), [])
    expect(listed(twentyFive)).toBe(20)
    expect(twentyFive).toContain('and 5 more')
    expect(twentyFive).not.toContain('n24')
  })

  it('says so when a key is not valid JSON', () => {
    expect(confirmationProblem(['not json'], [])).toContain('an unreadable flag')
  })

  it('counts the keys that are not flags of the plan, in the singular and the plural', () => {
    const own = keys(1)
    expect(confirmationProblem(own, [...own, 'x'])).toBe('1 confirmed key is not a flag of this plan')
    expect(confirmationProblem(own, [...own, 'x', 'y'])).toBe('2 confirmed keys are not a flag of this plan')
    expect(confirmationProblem(own, [...own, 'x', 'x'])).toBe('1 confirmed key is not a flag of this plan')
  })

  it('reports both problems in one message', () => {
    expect(confirmationProblem(keys(1), ['x'])).toMatch(/^confirm every flag before deploying; not confirmed: n0 at \/url; 1 confirmed key is not a flag of this plan$/)
  })
})

describe('plannedRecord', () => {
  it('keeps one key per flag, however often the planner repeats it', () => {
    const duplicate = { nodeId: 'n1', pointer: '/url', code: 'new_egress_target' as const, message: 'new target' }
    const other = { ...duplicate, code: 'untrusted_flow' as const }
    const planned = {
      kind: 'workflow' as const,
      workflow,
      summary: 's',
      flags: [duplicate, { ...duplicate }, other],
      needsConfirmation: true,
      rounds: [],
      usage,
      costUsd: 0,
      model: 'claude-sonnet-5-5',
      effort: 'medium' as const,
      fallbackUsed: false,
      meta: {
        provider: 'anthropic',
        effort: { requested: 'medium' as const, effective: 'medium' as const, native: 'medium', collapsed: false, cappedByRule: false },
        reasoningCapped: false,
        memoryUsed: 0,
        memoryDropped: 0,
      },
    }
    const { record } = plannedRecord({ planId: 'p-1', text: 'x', attachments: [], effort: 'medium' }, planned, 1)
    expect(record.flagKeys).toEqual([flagKey(duplicate), flagKey(other)])
  })
})
