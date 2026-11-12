import type { ExplainEffort } from '@rill/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client'
import { explainErrorKey, explainReducer, IDLE_EXPLAIN, type ExplainAction, type ExplainState } from './model/explain-state'

export interface ExplainControls {
  state: ExplainState
  open(effort?: ExplainEffort): void
  cancelNotice(): void
  send(effort: ExplainEffort): void
  reset(): void
}

interface Held {
  runId: string | undefined
  state: ExplainState
}

const DEFAULT_EFFORT: ExplainEffort = 'medium'

export function useExplain(client: EngineClient, runId: string | undefined): ExplainControls {
  const [held, setHeld] = useState<Held>({ runId, state: IDLE_EXPLAIN })
  const counter = useRef(0)
  const inflight = useRef<number | undefined>(undefined)

  if (held.runId !== runId) setHeld({ runId, state: IDLE_EXPLAIN })
  const state = held.runId === runId ? held.state : IDLE_EXPLAIN

  useEffect(
    () => () => {
      inflight.current = undefined
    },
    [runId],
  )

  const apply = useCallback((action: ExplainAction) => {
    setHeld((previous) => (previous.runId === runId ? { runId, state: explainReducer(previous.state, action) } : previous))
  }, [runId])

  const open = useCallback(
    (effort: ExplainEffort = DEFAULT_EFFORT) => {
      if (runId !== undefined) apply({ type: 'open', effort })
    },
    [apply, runId],
  )

  const cancelNotice = useCallback(() => apply({ type: 'cancel' }), [apply])

  const reset = useCallback(() => {
    inflight.current = undefined
    apply({ type: 'reset' })
  }, [apply])

  const send = useCallback(
    (effort: ExplainEffort) => {
      if (runId === undefined || inflight.current !== undefined) return
      counter.current += 1
      const requestId = counter.current
      inflight.current = requestId
      apply({ type: 'send', effort, requestId })
      client.request('explainRun', { runId, effort }).then(
        (result) => {
          if (inflight.current !== requestId) return
          inflight.current = undefined
          apply({ type: 'succeeded', requestId, result })
        },
        (error: unknown) => {
          if (inflight.current !== requestId) return
          inflight.current = undefined
          apply({ type: 'failed', requestId, key: explainErrorKey(error) })
        },
      )
    },
    [apply, client, runId],
  )

  return { state, open, cancelNotice, send, reset }
}
