import { useEffect, useState } from 'react'
import type { EngineClient } from '../../engine/client'

export interface PingState {
  state: 'pending' | 'ok' | 'error'
  ms?: number
}

interface Result extends PingState {
  client: EngineClient
}

export function usePing(client: EngineClient | undefined): PingState {
  const [result, setResult] = useState<Result | undefined>(undefined)

  useEffect(() => {
    if (client === undefined) return undefined
    let live = true
    const started = performance.now()
    client.request('ping', {}).then(
      () => {
        if (live) setResult({ client, state: 'ok', ms: Math.round(performance.now() - started) })
      },
      () => {
        if (live) setResult({ client, state: 'error' })
      },
    )
    return () => {
      live = false
    }
  }, [client])

  if (result === undefined || result.client !== client) return { state: 'pending' }
  return result.ms === undefined ? { state: result.state } : { state: result.state, ms: result.ms }
}
