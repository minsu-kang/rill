import { RillError, type Agent, type MethodName, type MethodParams, type MethodResult, type Skill } from '@rill/protocol'
import { useMemo } from 'react'
import type { EngineClient } from '../../engine/client'
import { createFakeClient } from '../../engine/fake-client'
import { createFakeHost, type FakeHostState } from '../../engine/fake-host'
import { withPlanMethods } from '../../engine/fake-plan'
import { fakeData } from '../../fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../../fixtures/plan'
import { Page } from '../Page'
import { SkillsScreen } from './SkillsScreen'

export interface SkillsStageProps {
  skills?: readonly Skill[]
  agents?: readonly Agent[]
  list?: 'hang' | 'fail'
  failSave?: string
  height?: number
  textPicks?: FakeHostState['textPicks']
}

function clientOf(props: SkillsStageProps): EngineClient {
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(props.skills === undefined ? {} : { skills: props.skills }),
    ...(props.agents === undefined ? {} : { agents: props.agents }),
  })
  return {
    onEvent: inner.onEvent,
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method === 'listSkills' && props.list === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listSkills' && props.list === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'saveSkill' && props.failSave !== undefined) throw new RillError(props.failSave, 'x', props.failSave === 'SKILL_INVALID' ? ['body.too_large_for_agent: the body would make the skills of 2 agents longer than 6000 characters together'] : [])
      return inner.request(method, params)
    },
  }
}

export function SkillsStage(props: SkillsStageProps) {
  const client = useMemo(() => clientOf(props), [props])
  const host = useMemo(() => createFakeHost({ textPicks: props.textPicks ?? [] }), [props.textPicks])
  return (
    <div style={{ height: props.height ?? 860, overflow: 'auto' }}>
      <Page>
        <SkillsScreen client={client} files={host.dialogs} />
      </Page>
    </div>
  )
}
