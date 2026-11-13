import { RillError, type MethodName, type MethodParams, type MethodResult, type Rule } from '@rill/protocol'
import { useMemo } from 'react'
import type { EngineClient } from '../../engine/client'
import { createFakeClient } from '../../engine/fake-client'
import { withPlanMethods } from '../../engine/fake-plan'
import { catalog, fakeData } from '../../fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../../fixtures/plan'
import type { RuleViolation } from '../../model/rules'
import { Page } from '../Page'
import { RulesScreen } from './RulesScreen'

export interface RulesStageProps {
  rules?: readonly Rule[]
  violations?: readonly RuleViolation[]
  list?: 'hang' | 'fail' | 'failLater'
  catalog?: 'loading' | 'error' | 'none'
  check?: 'hang' | 'fail'
  failSave?: { code: string; problems?: string[] }
  failDelete?: string
  height?: number
}

export function rulesClientOf(props: RulesStageProps): EngineClient {
  let lists = 0
  const inner = withPlanMethods(createFakeClient(fakeData), {
    models,
    script: () => outcomeOf(results.workflow),
    memory: [...memoryFixtures.three],
    ...(props.rules === undefined ? {} : { rules: props.rules }),
    ...(props.violations === undefined ? {} : { violations: () => [...props.violations!] }),
  })
  return {
    onEvent: inner.onEvent,
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method === 'listRules' && props.list === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'listRules' && props.list === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'listRules' && props.list === 'failLater' && ++lists > 1) throw new RillError('INTERNAL', 'x')
      if (method === 'checkRules' && props.check === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (method === 'checkRules' && props.check === 'fail') throw new RillError('INTERNAL', 'x')
      if (method === 'saveRule' && props.failSave !== undefined) throw new RillError(props.failSave.code, 'x', props.failSave.problems ?? [])
      if (method === 'deleteRule' && props.failDelete !== undefined) throw new RillError(props.failDelete, 'x')
      return inner.request(method, params)
    },
  }
}

export function RulesStage(props: RulesStageProps) {
  const client = useMemo(() => rulesClientOf(props), [props])
  return (
    <div style={{ height: props.height ?? 900, overflow: 'auto' }}>
      <Page>
        <RulesScreen client={client} catalog={props.catalog === undefined ? catalog : []} catalogStatus={props.catalog === undefined || props.catalog === 'none' ? 'ready' : props.catalog} onRetryCatalog={() => undefined} />
      </Page>
    </div>
  )
}
