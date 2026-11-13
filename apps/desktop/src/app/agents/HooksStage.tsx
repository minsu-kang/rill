import { RillError, type Hook, type HookLogEntry, type MethodName, type MethodParams, type MethodResult, type Rule } from '@rill/protocol'
import { useMemo } from 'react'
import type { EngineClient } from '../../engine/client'
import { createFakeClient } from '../../engine/fake-client'
import { withPlanMethods } from '../../engine/fake-plan'
import { fakeData } from '../../fixtures'
import { HOSTILE_WORKFLOW_NAME, LONG_WORKFLOW_NAME, hookConnections } from '../../fixtures/hooks'
import { memoryFixtures, models, outcomeOf, results } from '../../fixtures/plan'
import { workflowOf } from '../../fixtures/workflows'
import type { ConnectionSummary } from '../../shared/host-api'
import { Page } from '../Page'
import { HooksScreen } from './HooksScreen'

export interface HooksStageProps {
  hooks?: readonly Hook[]
  hookLog?: readonly HookLogEntry[]
  rules?: readonly Rule[]
  connections?: readonly ConnectionSummary[] | 'unknown'
  workflows?: 'hostile'
  list?: 'hang' | 'fail' | 'failLater'
  log?: 'hang' | 'fail'
  workflowList?: 'hang' | 'fail'
  failSave?: { code: string; problems?: string[] }
  failDelete?: string
  openSettings?: boolean
  width?: number
  height?: number | string
}

export function hooksClientOf(props: HooksStageProps): EngineClient {
  let lists = 0
  const connections = props.connections === undefined || props.connections === 'unknown' ? hookConnections : props.connections
  const workflows =
    props.workflows === 'hostile'
      ? [
          ...fakeData.workflows,
          { id: 'wf-hostile', workflow: workflowOf(HOSTILE_WORKFLOW_NAME, [], []), active: false, createdAt: 2 },
          { id: 'wf-long', workflow: workflowOf(LONG_WORKFLOW_NAME, [], []), active: false, createdAt: 1 },
        ]
      : fakeData.workflows
  const inner = withPlanMethods(createFakeClient({ ...fakeData, workflows }), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    connections: connections.map((entry) => ({ name: entry.name, kind: entry.kind })),
    ...(props.hooks === undefined ? {} : { hooks: props.hooks }),
    ...(props.hookLog === undefined ? {} : { hookLog: props.hookLog }),
    ...(props.rules === undefined ? {} : { rules: props.rules }),
  })
  return {
    onEvent: inner.onEvent,
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method === 'listHooks' && props.list === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listHooks' && props.list === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'listHooks' && props.list === 'failLater' && ++lists > 1) throw new RillError('INTERNAL', 'x')
      if (method === 'listHookLog' && props.log === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listHookLog' && props.log === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'listWorkflows' && props.workflowList === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listWorkflows' && props.workflowList === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'saveHook' && props.failSave !== undefined) throw new RillError(props.failSave.code, 'x', props.failSave.problems ?? [])
      if (method === 'deleteHook' && props.failDelete !== undefined) throw new RillError(props.failDelete, 'x')
      return inner.request(method, params)
    },
  }
}

export function HooksStage(props: HooksStageProps) {
  const client = useMemo(() => hooksClientOf(props), [props])
  const connections = props.connections === 'unknown' ? undefined : (props.connections ?? hookConnections)
  return (
    <div style={{ height: props.height ?? '100vh', width: props.width, overflow: 'auto' }}>
      <Page>
        <HooksScreen client={client} connections={connections} timeZone="UTC" {...(props.openSettings === true ? { onOpenConnections: () => undefined } : {})} />
      </Page>
    </div>
  )
}
