import { Db, Engine } from '@rill/engine'
import { createCoreRegistry } from '@rill/nodes-core'
import type { NodeInfo } from '@rill/protocol'

export function buildCatalog(): NodeInfo[] {
  return new Engine({ db: Db.open(':memory:'), registry: createCoreRegistry() }).nodeCatalog()
}
