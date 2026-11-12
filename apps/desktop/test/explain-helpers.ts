import { RillError, type EngineEvent, type ExplainResult, type MethodName, type MethodParams, type MethodResult } from '@rill/protocol'
import type { EngineClient } from '../src/engine/client'

export interface PendingExplain {
  params: MethodParams<'explainRun'>
  resolve(result: ExplainResult): void
  reject(error: unknown): void
}

export function manualExplainClient(): { client: EngineClient; calls: PendingExplain[]; requests: Array<{ method: string; params: unknown }> } {
  const calls: PendingExplain[] = []
  const requests: Array<{ method: string; params: unknown }> = []
  const listeners = new Set<(event: EngineEvent) => void>()
  const client: EngineClient = {
    request: <M extends MethodName>(method: M, params: MethodParams<M>) => {
      requests.push({ method, params })
      if (method !== 'explainRun') return Promise.reject(new RillError('UNKNOWN_METHOD', method))
      return new Promise<MethodResult<M>>((resolve, reject) => {
        calls.push({ params: params as MethodParams<'explainRun'>, resolve: resolve as (result: ExplainResult) => void, reject })
      })
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return { client, calls, requests }
}
