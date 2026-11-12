import { METHODS, RillError, type ExplainResult, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import Value from 'typebox/value'
import type { EngineClient } from './client'

export type ExplainScript = (params: MethodParams<'explainRun'>) => ExplainResult | RillError | 'hang'

export function withExplainMethod(client: EngineClient, script: ExplainScript): EngineClient {
  return {
    onEvent: (listener) => client.onEvent(listener),
    request: async <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => {
      if (method !== 'explainRun') return client.request(method, params)
      if (!Value.Check(METHODS.explainRun.params, params)) throw new RillError('INVALID_PARAMS', 'invalid explainRun params')
      const answer = script(params)
      if (answer === 'hang') return new Promise<MethodResult<M>>(() => undefined)
      if (answer instanceof RillError) throw answer
      if (!Value.Check(METHODS.explainRun.result, answer)) throw new RillError('INTERNAL', 'the fake explainRun answer does not match the protocol')
      return structuredClone(answer) as MethodResult<M>
    },
  }
}
