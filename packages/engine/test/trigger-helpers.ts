import type { Workflow } from '@rill/dsl'
import type { Clock } from '../src/clock'
import { Db } from '../src/db'
import type { EngineEventInput } from '../src/events'
import { Store } from '../src/store'
import type { FireOptions, TriggerHost } from '../src/triggers/types'

const WORKFLOW: Workflow = {
  schemaVersion: 1,
  name: 'wf',
  nodes: [{ id: 't1', type: 'trigger.manual@1', config: {} }],
  edges: [],
}

export interface FiredRun {
  payload: unknown
  options: FireOptions | undefined
  runId: string
}

export function createHost(clock: Clock) {
  const store = new Store(Db.open(':memory:'), () => clock.now())
  const workflowId = store.saveWorkflow(WORKFLOW)
  const fired: FiredRun[] = []
  const events: EngineEventInput[] = []
  let busy = false
  let failure: Error | undefined
  const host: TriggerHost = {
    store,
    clock,
    fire: (id, payload, options) => {
      if (failure) throw failure
      const run = store.createTriggeredRun({ workflowId: id, payload, fingerprint: options?.fingerprint })
      fired.push({ payload, options, runId: run.id })
      return { runId: run.id }
    },
    isBusy: () => busy,
    emit: (event) => {
      events.push(event)
    },
  }
  return {
    host,
    store,
    workflowId,
    fired,
    events,
    setBusy: (value: boolean) => {
      busy = value
    },
    failFires: (value: boolean | Error) => {
      failure = value === false ? undefined : value instanceof Error ? value : new Error('fire failed')
    },
  }
}
