import type { Workflow } from '@rill/dsl'
import type { AttachmentRef, PlanMeta, PlanResultBody } from '@rill/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import {
  PlanDeployedError,
  PlanExistsError,
  PlanNotFoundError,
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

  it('keeps the order of arrays', () => {
    const swapped = { ...workflow, nodes: [workflow.nodes[1]!, workflow.nodes[0]!] }
    expect(workflowHash(swapped)).not.toBe(workflowHash(workflow))
    const rows = (row: unknown[]) => workflowHash({ ...workflow, nodes: [workflow.nodes[0]!, { id: 'n1', type: 'csv.append@1', config: { row } }] })
    expect(rows(['a', 'b'])).not.toBe(rows(['b', 'a']))
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
  })
})
