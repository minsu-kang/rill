import { NodeRegistry } from './registry'
import { condition } from './nodes/condition'
import { csvAppend } from './nodes/csv-append'
import { delay } from './nodes/delay'
import { transform } from './nodes/transform'
import { triggerManual } from './nodes/trigger-manual'

export function createCoreRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(triggerManual)
    .register(transform)
    .register(csvAppend)
    .register(condition)
    .register(delay)
}
