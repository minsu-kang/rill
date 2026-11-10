import { NodeRegistry } from './registry'
import { csvAppend } from './nodes/csv-append'
import { transform } from './nodes/transform'
import { triggerManual } from './nodes/trigger-manual'

export function createCoreRegistry(): NodeRegistry {
  return new NodeRegistry().register(triggerManual).register(transform).register(csvAppend)
}
