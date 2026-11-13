import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { EngineEventSchema } from '../src/index'

const valid = [
  { type: 'run.started', at: 1, runId: 'r', workflowId: 'w', dryRun: false },
  { type: 'step.started', at: 1, runId: 'r', nodeId: 'n1', attempt: 1 },
  { type: 'step.succeeded', at: 1, runId: 'r', nodeId: 'n1', attempt: 2 },
  { type: 'step.failed', at: 1, runId: 'r', nodeId: 'n1', attempt: 1, error: 'boom', willRetry: true },
  { type: 'step.skipped', at: 1, runId: 'r', nodeId: 'n1' },
  { type: 'step.continued', at: 1, runId: 'r', nodeId: 'n1', attempt: 1, error: 'boom' },
  { type: 'run.finished', at: 1, runId: 'r', status: 'succeeded', error: null },
  { type: 'run.finished', at: 1, runId: 'r', status: 'failed', error: 'node a failed: x' },
  { type: 'trigger.fired', at: 1, workflowId: 'w', runId: 'r' },
  { type: 'trigger.skipped', at: 1, workflowId: 'w', reason: 'missed schedule' },
  { type: 'trigger.error', at: 1, workflowId: 'w', error: 'folder does not exist' },
  { type: 'workflow.activated', at: 1, workflowId: 'w' },
  { type: 'workflow.deactivated', at: 1, workflowId: 'w' },
  { type: 'workflow.deleted', at: 1, workflowId: 'w' },
]

describe('EngineEventSchema', () => {
  it.each(valid)('accepts %j', (event) => {
    expect(Value.Check(EngineEventSchema, event)).toBe(true)
  })

  it('rejects unknown types, missing or extra fields, and wrong field types', () => {
    const bad = [
      { type: 'run.exploded', at: 1 },
      { type: 'run.started', runId: 'r', workflowId: 'w', dryRun: false },
      { type: 'run.started', at: 1, runId: 'r', workflowId: 'w', dryRun: false, extra: true },
      { type: 'run.started', at: '1', runId: 'r', workflowId: 'w', dryRun: false },
      { type: 'step.started', at: 1, runId: 'r', nodeId: 'n1', attempt: 0 },
      { type: 'run.finished', at: 1, runId: 'r', status: 'cancelled', error: null },
      { type: 'run.finished', at: 1, runId: 'r', status: 'failed' },
      { type: 'step.failed', at: 1, runId: 'r', nodeId: 'n1', attempt: 1, error: 'x' },
      { type: 'workflow.deleted', at: 1 },
      { type: 'workflow.deleted', at: 1, workflowId: '' },
      { type: 'workflow.deleted', at: 1, workflowId: 'w', extra: true },
      null,
      'run.started',
    ]
    for (const event of bad) expect(Value.Check(EngineEventSchema, event)).toBe(false)
  })
})
