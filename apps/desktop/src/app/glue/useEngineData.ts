import type { NodeInfo } from '@rill/protocol'
import { useCallback, useEffect, useState } from 'react'
import type { EngineClient } from '../../engine/client'

export type CatalogStatus = 'loading' | 'ready' | 'error'

export interface EngineData {
  catalog: readonly NodeInfo[]
  catalogStatus: CatalogStatus
  reloadCatalog(): void
  model: { provider: string; model: string } | undefined
}

const NO_CATALOG: readonly NodeInfo[] = []

interface CatalogAnswer {
  client: EngineClient
  attempt: number
  nodes: readonly NodeInfo[] | undefined
}

export function useEngineData(client: EngineClient | undefined): EngineData {
  const [answer, setAnswer] = useState<CatalogAnswer | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [model, setModel] = useState<{ client: EngineClient; model: EngineData['model'] } | undefined>(undefined)

  useEffect(() => {
    if (client === undefined) return undefined
    let live = true
    client.request('nodeCatalog', {}).then(
      ({ nodes }) => {
        if (live) setAnswer({ client, attempt, nodes })
      },
      () => {
        if (live) setAnswer({ client, attempt, nodes: undefined })
      },
    )
    return () => {
      live = false
    }
  }, [client, attempt])

  useEffect(() => {
    if (client === undefined) return undefined
    let live = true
    client.request('llmModels', {}).then(
      (result) => {
        if (live) setModel({ client, model: result.active === null ? undefined : { provider: result.active.provider, model: result.active.model } })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [client])

  const reloadCatalog = useCallback(() => setAttempt((value) => value + 1), [])
  const current = answer !== undefined && answer.client === client && answer.attempt === attempt ? answer : undefined
  return {
    catalog: current?.nodes ?? NO_CATALOG,
    catalogStatus: current === undefined ? 'loading' : current.nodes === undefined ? 'error' : 'ready',
    reloadCatalog,
    model: model !== undefined && model.client === client ? model.model : undefined,
  }
}
