import type { NodeInfo } from '@rill/protocol'
import { useEffect, useState } from 'react'
import type { EngineClient } from '../../engine/client'

export interface EngineData {
  catalog: readonly NodeInfo[]
  model: { provider: string; model: string } | undefined
}

const NO_CATALOG: readonly NodeInfo[] = []

export function useEngineData(client: EngineClient | undefined): EngineData {
  const [catalog, setCatalog] = useState<{ client: EngineClient; nodes: readonly NodeInfo[] } | undefined>(undefined)
  const [model, setModel] = useState<{ client: EngineClient; model: EngineData['model'] } | undefined>(undefined)

  useEffect(() => {
    if (client === undefined) return undefined
    let live = true
    client.request('nodeCatalog', {}).then(
      ({ nodes }) => {
        if (live) setCatalog({ client, nodes })
      },
      () => undefined,
    )
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

  return { catalog: catalog !== undefined && catalog.client === client ? catalog.nodes : NO_CATALOG, model: model !== undefined && model.client === client ? model.model : undefined }
}
