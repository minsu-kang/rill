import type { NodeDefinition } from './types'

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition>()

  register(def: NodeDefinition): this {
    if (this.defs.has(def.type)) throw new Error(`node type already registered: ${def.type}`)
    this.defs.set(def.type, def)
    return this
  }

  get(type: string): NodeDefinition | undefined {
    return this.defs.get(type)
  }

  has(type: string): boolean {
    return this.defs.has(type)
  }

  list(): NodeDefinition[] {
    return [...this.defs.values()]
  }
}
