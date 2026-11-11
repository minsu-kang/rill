import type { Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import {
  PlanError,
  applyPatch,
  createPlanner,
  decodeGeneration,
  decodePatchOps,
  encodeGeneration,
  generationSchema,
  labelIssuesForPatch,
  touchedOutsideSelection,
  type PatchOp,
  type PlanResultBody,
} from '../src/index'
import { FakeProvider } from './fake-provider'
import { ROOT, receipts, registry, request } from './fixtures'

function existing(): Workflow {
  const workflow = receipts()
  workflow.nodes[0]!.config = { ...workflow.nodes[0]!.config, pollMs: 500, stableMs: 2000 }
  return workflow
}

function patchData(ops: PatchOp[], summary = 'Changed'): unknown {
  return encodeGeneration({ kind: 'workflow', workflow: existing(), summary, patch: ops, flags: [], needsConfirmation: false })
}

function patchRequest(nodeId = 'n2') {
  return request({ text: 'change it', selection: { nodeId }, context: { ...request().context, existingWorkflow: existing() } })
}

async function planError(promise: Promise<unknown>): Promise<PlanError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlanError) return error
    throw error
  }
  throw new Error('expected a PlanError')
}

describe('applyPatch', () => {
  it('removes a node together with its edges', () => {
    const { workflow, issues } = applyPatch(existing(), [{ op: 'remove_node', nodeId: 'n1' }], registry)
    expect(issues).toEqual([])
    expect(workflow.nodes.map((n) => n.id)).toEqual(['t1', 'n2'])
    expect(workflow.edges).toEqual([])
  })

  it('replaces a config but keeps the hidden advanced fields of the node', () => {
    const { workflow } = applyPatch(existing(), [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/Other` } }], registry)
    expect(workflow.nodes[0]!.config).toEqual({ folder: `${ROOT}/Other`, pollMs: 500, stableMs: 2000 })
    const replaced = applyPatch(existing(), [{ op: 'set_config', nodeId: 'n2', config: { file: `${ROOT}/b.csv`, row: ['x'] } }], registry)
    expect(replaced.workflow.nodes[2]!.config).toEqual({ file: `${ROOT}/b.csv`, row: ['x'] })
  })

  it('adds, connects and disconnects in order', () => {
    const ops: PatchOp[] = [
      { op: 'add_node', node: { id: 'n3', type: 'delay@1', config: { ms: 5 } } },
      { op: 'disconnect', from: 'n1', to: 'n2' },
      { op: 'connect', edge: { from: 'n1', to: 'n3' } },
      { op: 'connect', edge: { from: 'n3', to: 'n2' } },
    ]
    const { workflow, issues } = applyPatch(existing(), ops, registry)
    expect(issues).toEqual([])
    expect(workflow.edges).toEqual([
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n3' },
      { from: 'n3', to: 'n2' },
    ])
  })

  it('reports unknown ids, duplicate nodes and edges at /patch pointers', () => {
    const ops: PatchOp[] = [
      { op: 'set_config', nodeId: 'zz', config: {} },
      { op: 'remove_node', nodeId: 'yy' },
      { op: 'add_node', node: { id: 'n1', type: 'delay@1', config: { ms: 1 } } },
      { op: 'connect', edge: { from: 'xx', to: 'n1' } },
      { op: 'connect', edge: { from: 'n1', to: 'ww' } },
      { op: 'connect', edge: { from: 't1', to: 'n1', when: 'true' } },
      { op: 'disconnect', from: 'n2', to: 'n1' },
    ]
    const { workflow, issues } = applyPatch(existing(), ops, registry)
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/patch/0/nodeId', 'patch_unknown_node'],
      ['/patch/1/nodeId', 'patch_unknown_node'],
      ['/patch/2/nodeId', 'patch_duplicate_node'],
      ['/patch/3/from', 'patch_unknown_node'],
      ['/patch/4/to', 'patch_unknown_node'],
      ['/patch/5/to', 'patch_duplicate_edge'],
      ['/patch/6/to', 'patch_unknown_edge'],
    ])
    expect(issues[0]!.hint).toBe('existing ids: t1, n1, n2')
    expect(workflow).toEqual(existing())
  })

  it('does not change the existing workflow', () => {
    const before = existing()
    applyPatch(before, [{ op: 'set_config', nodeId: 't1', config: { folder: 'x' } }, { op: 'remove_node', nodeId: 'n2' }], registry)
    expect(before).toEqual(existing())
  })
})

describe('patch helpers', () => {
  it('decodes flat ops and reports missing fields and bad config text', () => {
    const { ops, issues } = decodePatchOps([
      { op: 'add_node', nodeId: 'n3', type: 'delay@1', config: '{"ms":1}', retry: { maxAttempts: 2 }, onError: 'continue' },
      { op: 'add_node', nodeId: 'n4' },
      { op: 'set_config', nodeId: 'n1', config: 'nope' },
      { op: 'remove_node' },
      { op: 'connect', from: 'a', to: 'b', when: 'true' },
      { op: 'disconnect', from: 'a' },
    ])
    expect(ops).toEqual([
      { op: 'add_node', node: { id: 'n3', type: 'delay@1', config: { ms: 1 }, retry: { maxAttempts: 2 }, onError: 'continue' } },
      { op: 'connect', edge: { from: 'a', to: 'b', when: 'true' } },
    ])
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/patch/1/type', 'patch_missing_field'],
      ['/patch/1/config', 'patch_missing_field'],
      ['/patch/2/config', 'config_json_parse'],
      ['/patch/3/nodeId', 'patch_missing_field'],
      ['/patch/5/to', 'patch_missing_field'],
    ])
  })

  it('lists existing nodes other than the selection that the patch touches', () => {
    const ops: PatchOp[] = [
      { op: 'set_config', nodeId: 'n2', config: {} },
      { op: 'set_config', nodeId: 'n1', config: {} },
      { op: 'add_node', node: { id: 'n9', type: 'delay@1', config: {} } },
      { op: 'connect', edge: { from: 'n2', to: 'n9' } },
      { op: 'disconnect', from: 't1', to: 'n1' },
      { op: 'remove_node', nodeId: 'n9' },
    ]
    expect(touchedOutsideSelection(ops, existing(), 'n2')).toEqual(['n1', 't1'])
    const direct: PatchOp[] = [
      { op: 'set_config', nodeId: 'n2', config: {} },
      { op: 'disconnect', from: 'n1', to: 'n2' },
      { op: 'connect', edge: { from: 'n1', to: 'n2' } },
    ]
    expect(touchedOutsideSelection(direct, existing(), 'n2')).toEqual([])
  })

  it('names the node or edge in issues on the patched workflow', () => {
    const workflow = existing()
    const labelled = labelIssuesForPatch(
      [
        { stage: 2, pointer: '/nodes/1', code: 'unreachable', message: 'node not reachable from trigger: n1' },
        { stage: 3, pointer: '/nodes/2/config/row/0', code: 'unknown_output_field', message: 'node n2: n1.output has no field x' },
        { stage: 3, pointer: '/edges/1/when', code: 'when_not_branching', message: 'remove when' },
        { stage: 3, pointer: '/edges/0/when', code: 'when_not_branching', message: 'edge t1 -> n1: x' },
        { stage: 2, pointer: '/nodes', code: 'trigger_count', message: 'two triggers' },
        { stage: 2, pointer: '/nodes/7', code: 'unreachable', message: 'gone' },
      ],
      workflow,
    )
    expect(labelled.map((i) => i.message)).toEqual([
      'node n1: node not reachable from trigger: n1',
      'node n2: n1.output has no field x',
      'edge n1 -> n2: remove when',
      'edge t1 -> n1: x',
      'two triggers',
      'gone',
    ])
  })

  it('round-trips a patch body through the codec', () => {
    const ops: PatchOp[] = [{ op: 'set_config', nodeId: 'n2', config: { file: `${ROOT}/b.csv`, row: ['{{n1.output.date}}'] } }]
    const decoded = decodeGeneration(patchData(ops), { registry, context: patchRequest().context, mode: 'patch', selection: 'n2' })
    expect(decoded.issues).toEqual([])
    const body = decoded.body as Extract<PlanResultBody, { kind: 'workflow' }>
    expect(body.patch).toEqual(ops)
    expect(body.workflow).toEqual(applyPatch(existing(), ops, registry).workflow)
    expect(decodeGeneration(encodeGeneration(body), { registry, context: patchRequest().context, mode: 'patch', selection: 'n2' }).body).toEqual(body)
  })

  it('adds the also-changed line once when a patch body is decoded again', () => {
    const ops: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/New` } }]
    const ctx = { registry, context: patchRequest().context, mode: 'patch' as const, selection: 'n2' }
    const body = decodeGeneration(patchData(ops, 'Moved'), ctx).body!
    expect(body.summary).toBe('Moved\nAlso changed: t1.')
    expect(decodeGeneration(encodeGeneration(body), ctx).body!.summary).toBe('Moved\nAlso changed: t1.')
    expect(decodeGeneration(patchData(ops, ''), ctx).body!.summary).toBe('Also changed: t1.')
  })

  it('reports a patch without an existing workflow', () => {
    const decoded = decodeGeneration(patchData([{ op: 'remove_node', nodeId: 'n2' }]), { registry, context: request().context, mode: 'patch' })
    expect(decoded.issues.map((i) => i.code)).toEqual(['patch_without_workflow'])
  })
})

describe('patch mode in the planner', () => {
  it('rejects a selection without an existing workflow before any call', async () => {
    const provider = new FakeProvider([])
    const error = await planError(createPlannerFor(provider).plan(request({ selection: { nodeId: 'n2' } })))
    expect(error.kind).toBe('invalid_after_repair')
    expect(error.rounds).toEqual([])
    expect(error.lastIssues.map((i) => [i.pointer, i.code])).toEqual([['/selection/nodeId', 'selection_without_workflow']])
    const unknown = await planError(createPlannerFor(provider).plan(patchRequest('zz')))
    expect(unknown.lastIssues.map((i) => i.code)).toEqual(['selection_unknown_node'])
    expect(provider.calls).toHaveLength(0)
  })

  it('sends the existing workflow and the patch schema and returns the full resulting workflow', async () => {
    const ops: PatchOp[] = [{ op: 'set_config', nodeId: 'n2', config: { file: `${ROOT}/b.csv`, row: ['{{n1.output.amount}}'] } }]
    const provider = new FakeProvider([{ data: patchData(ops) }])
    const result = await createPlannerFor(provider).plan(patchRequest())
    const sent = provider.calls[0]!.request
    expect(sent.schema).toEqual(generationSchema(registry, { mode: 'patch' }))
    const text = sent.messages[0]!.content as string
    expect(text).toContain('Patch mode: change the existing workflow below for the selected node n2.')
    expect(text).toContain(JSON.stringify(existing()))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.patch).toEqual(ops)
    expect(result.workflow.nodes[2]!.config).toEqual(ops[0]!.op === 'set_config' ? ops[0]!.config : {})
    expect(result.workflow.nodes[0]!.config).toEqual(existing().nodes[0]!.config)
    expect(result.summary).toBe('Changed')
  })

  it('lists other changed nodes in the summary', async () => {
    const ops: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/New` } }]
    const result = await createPlannerFor(new FakeProvider([{ data: patchData(ops, 'Moved') }])).plan(patchRequest())
    expect(result.kind === 'workflow' && result.summary).toBe('Moved\nAlso changed: t1.')
    if (result.kind === 'workflow') expect(result.workflow.nodes[0]!.config).toEqual({ folder: `${ROOT}/New`, pollMs: 500, stableMs: 2000 })
  })

  it('reports hidden fields the model sets in a patch', async () => {
    const ops: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/New`, pollMs: 100 } }]
    const fixed: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/New` } }]
    const provider = new FakeProvider([{ data: patchData(ops) }, { data: patchData(fixed) }])
    const result = await createPlannerFor(provider).plan(patchRequest('t1'))
    expect(result.rounds[0]!.issues.map((i) => [i.pointer, i.code])).toEqual([['/patch/0/config/pollMs', 'planner_hidden_field']])
    expect(result.rounds).toHaveLength(2)
  })

  it('labels issues of the patched workflow with node ids for the next patch', async () => {
    const ops: PatchOp[] = [{ op: 'add_node', node: { id: 'n9', type: 'delay@1', config: { ms: 1 } } }]
    const provider = new FakeProvider([{ data: patchData(ops) }, { data: patchData([...ops, { op: 'connect', edge: { from: 'n2', to: 'n9' } }]) }])
    const result = await createPlannerFor(provider).plan(patchRequest())
    const sent = JSON.parse(provider.calls[1]!.request.messages[2]!.content as string) as { issues: { pointer: string; message: string }[] }
    expect(sent.issues).toEqual([expect.objectContaining({ pointer: '/nodes/3', message: 'node n9: node not reachable from trigger: n9' })])
    expect(result.kind === 'workflow' && result.workflow.edges.at(-1)).toEqual({ from: 'n2', to: 'n9' })
  })

  it('repairs a node config in patch mode with a targeted call and keeps hidden fields', async () => {
    const ops: PatchOp[] = [{ op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/New`, glob: 'a/b' } }]
    const provider = new FakeProvider([{ data: patchData(ops) }, { data: { folder: `${ROOT}/New`, glob: '*.pdf' } }])
    const result = await createPlannerFor(provider).plan(patchRequest('t1'))
    if (result.kind !== 'workflow') throw new Error('expected a workflow')
    expect(result.rounds.map((r) => r.targeted)).toEqual([[], ['t1']])
    expect(result.patch).toEqual([...ops, { op: 'set_config', nodeId: 't1', config: { folder: `${ROOT}/New`, glob: '*.pdf' } }])
    expect(provider.calls).toHaveLength(2)
    expect(result.workflow.nodes[0]!.config).toEqual({ folder: `${ROOT}/New`, glob: '*.pdf', pollMs: 500, stableMs: 2000 })
    const text = provider.calls[1]!.request.messages[0]!.content as string
    expect(text).toContain('Current config of the node (JSON):\n{"folder":"/rill-planner-test-root/New","glob":"a/b"}')
  })
})

function createPlannerFor(provider: FakeProvider) {
  return createPlanner({ provider, registry })
}
