import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { useState } from 'react'
import type { EngineClient } from '../../engine/client'
import { catalog, FIXTURE_NOW, fakeData, workflowOf, node, edge } from '../../fixtures'
import { createFakeWorld, type FakeWorldControl } from '../fake-world'
import { WorkflowActions } from './WorkflowActions'
import { useWorkflowList } from './useWorkflowList'

const manualWorkflow = workflowOf(
  '수동 정리',
  [
    node('start', 'trigger.manual@1', {}),
    node('extract', 'llm.extract@1', { file: '/Users/demo/a.pdf', fields: [{ name: 'amount', type: 'number', description: 'Total' }] }),
    node('send', 'http.request@1', { url: 'https://hooks.example.com/ingest', method: 'POST' }),
    node('append', 'csv.append@1', { file: '/Users/demo/ledger.csv', row: ['x'] }),
  ],
  [edge('start', 'extract'), edge('extract', 'send'), edge('send', 'append')],
)

export interface ActionsStageProps {
  workflowId: string
  control?: Partial<FakeWorldControl>
  hangStart?: boolean
  deleteBehavior?: 'hang' | 'busy' | 'fail'
}

export const STAGE_MANUAL_ID = 'wf-manual'
export const STAGE_HOSTILE_ID = 'wf-hostile'

const hostileWorkflow = workflowOf('<img src=x onerror=alert(1)> \u202E 아주 아주 긴 워크플로우 이름이 이어져요 아주 아주 긴 워크플로우 이름이 이어져요 아주 아주 긴 워크플로우 이름', [node('start', 'trigger.manual@1', {})], [])

export function ActionsStage({ workflowId, control, hangStart = false, deleteBehavior }: ActionsStageProps) {
  const [{ client }] = useState(() => {
    const world = createFakeWorld({
      hostOptions: { restartDelayMs: 0 },
      workflows: [
        ...fakeData.workflows,
        { id: STAGE_MANUAL_ID, workflow: manualWorkflow, active: false, createdAt: FIXTURE_NOW },
        { id: STAGE_HOSTILE_ID, workflow: hostileWorkflow, active: false, createdAt: FIXTURE_NOW },
      ],
      control: { stepIntervalMs: 600, ...control },
    })
    const wrapped: EngineClient =
      hangStart || deleteBehavior !== undefined
        ? {
            onEvent: world.client.onEvent,
            request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
              if (hangStart && method === 'startRun') return new Promise<MethodResult<M>>(() => undefined)
              if (method === 'deleteWorkflow' && deleteBehavior === 'hang') return new Promise<MethodResult<M>>(() => undefined)
              if (method === 'deleteWorkflow' && deleteBehavior === 'busy') return Promise.reject(new RillError('WORKFLOW_BUSY', 'a run is active'))
              if (method === 'deleteWorkflow' && deleteBehavior === 'fail') return Promise.reject(new RillError('INTERNAL', 'x'))
              return world.client.request(method, params)
            },
          }
        : world.client
    return { client: wrapped }
  })
  const [started, setStarted] = useState<string | undefined>(undefined)
  const list = useWorkflowList(client)
  const summary = list.workflows.find((item) => item.id === workflowId)
  if (summary === undefined) return null
  return (
    <div style={{ maxWidth: 720 }}>
      <WorkflowActions client={client} workflowId={workflowId} summary={summary} catalog={catalog} onRunStarted={setStarted} />
      {started === undefined ? null : <p data-testid="started">{started}</p>}
    </div>
  )
}
