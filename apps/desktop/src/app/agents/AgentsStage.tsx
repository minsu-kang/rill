import { RillError, type Agent, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { useMemo } from 'react'
import type { EngineClient } from '../../engine/client'
import { createFakeClient } from '../../engine/fake-client'
import { withPlanMethods } from '../../engine/fake-plan'
import { fakeData } from '../../fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../../fixtures/plan'
import { Page } from '../Page'
import { AgentsScreen } from './AgentsScreen'

export interface AgentsStageProps {
  agents?: readonly Agent[]
  activeAgentId?: string
  list?: 'hang' | 'fail'
  failSave?: string
  height?: number
}

function clientOf(props: AgentsStageProps): EngineClient {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(props.agents === undefined ? {} : { agents: props.agents }),
    ...(props.activeAgentId === undefined ? {} : { activeAgentId: props.activeAgentId }),
  })
  return {
    onEvent: inner.onEvent,
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method === 'listAgents' && props.list === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listAgents' && props.list === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'saveAgent' && props.failSave !== undefined) throw new RillError(props.failSave, 'x')
      return inner.request(method, params)
    },
  }
}

export function AgentsStage(props: AgentsStageProps) {
  const client = useMemo(() => clientOf(props), [props])
  return (
    <div style={{ height: props.height ?? 760, overflow: 'auto' }}>
      <Page>
        <AgentsScreen client={client} />
      </Page>
    </div>
  )
}
