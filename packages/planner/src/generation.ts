import type { JsonSchema } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import type { PlanResultBody } from './types'

export function generationSchema(registry: NodeRegistry): JsonSchema {
  void registry
  throw new Error('generationSchema is not implemented yet')
}

export function encodeGeneration(body: PlanResultBody): unknown {
  void body
  throw new Error('encodeGeneration is not implemented yet')
}
