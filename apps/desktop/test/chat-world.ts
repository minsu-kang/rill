import { RillError, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import { vi } from 'vitest'
import type { EngineClient } from '../src/engine/client'
import { createFakeClient } from '../src/engine/fake-client'
import { withPlanMethods, type FakePlanData, type PlanOutcome } from '../src/engine/fake-plan'
import { fakeData } from '../src/fixtures'
import { memoryFixtures, models, outcomeOf, results } from '../src/fixtures/plan'

export type Script = FakePlanData['script']

export interface WorldOptions {
  models?: FakePlanData['models']
  memory?: FakePlanData['memory']
  script?: Script
  delayMs?: number
  intercept?: (method: MethodName, params: unknown) => Promise<unknown> | undefined
}

export interface Call {
  method: MethodName
  params: unknown
}

export function scripted(list: ReadonlyArray<PlanOutcome | RillError | 'hang'>): Script {
  let index = 0
  return () => {
    const next = list[Math.min(index, list.length - 1)]!
    index += 1
    return next
  }
}

export function makeWorld(options: WorldOptions = {}) {
  const base = createFakeClient(fakeData)
  const data: FakePlanData = {
    models: options.models ?? models,
    script: options.script ?? (() => outcomeOf(results.workflow)),
    memory: options.memory ?? [...memoryFixtures.three],
    deployId: 'wf-new',
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
  }
  const planClient = withPlanMethods(base, data)
  const calls: Call[] = []
  const onEvent = vi.fn(planClient.onEvent)
  const client: EngineClient & { pendingPlans(): string[] } = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      calls.push({ method, params })
      const replaced = options.intercept?.(method, params)
      return (replaced ?? planClient.request(method, params)) as Promise<MethodResult<M>>
    },
    onEvent,
    pendingPlans: planClient.pendingPlans,
  }
  const planCalls = (): Array<MethodParams<'plan'>> => calls.filter((call) => call.method === 'plan').map((call) => call.params as MethodParams<'plan'>)
  const callsOf = (method: MethodName): Call[] => calls.filter((call) => call.method === method)
  return { client, calls, planCalls, callsOf, onEvent }
}
