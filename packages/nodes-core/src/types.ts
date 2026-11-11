import type { LlmProvider } from '@rill/llm'
import type Type from 'typebox'

export type SideEffect = 'none' | 'idempotent' | 'external'

export interface JournalEntry {
  state: 'intent' | 'done'
  data: string | null
}

export interface Journal {
  get(key: string): JournalEntry | undefined
  put(key: string, state: JournalEntry['state'], data?: string): void
}

export interface ConnectionResolver {
  get(id: string): string | undefined
}

export interface NodeContext {
  runId: string
  nodeId: string
  attempt: number
  dryRun: boolean
  idempotencyKey: string
  journal: Journal
  sleep(ms: number): Promise<void>
  allowedRoots: string[] | undefined
  connections: ConnectionResolver
  llm?: LlmProvider
}

export const FIELD_ROLES = ['path', 'url', 'connection', 'recipient', 'message'] as const

export type FieldRole = (typeof FIELD_ROLES)[number]

export type FieldRoles = Readonly<Record<string, FieldRole>>

export interface RuleIssue {
  code: string
  pointer: string
}

interface NodeBase {
  type: string
  title: string
  description: string
  outputSchema: Type.TSchema
  roles?: FieldRoles
  ruleIssue?: RuleIssue
}

export interface TriggerNodeDefinition extends NodeBase {
  kind: 'trigger'
  configSchema: Type.TSchema
  validate?(config: unknown): string[]
}

export interface ActionNodeDefinition extends NodeBase {
  kind: 'action'
  sideEffect: SideEffect
  configSchema: Type.TSchema
  lenientRefs?: boolean
  outputSchemaFor?(config: unknown): Type.TSchema
  validate?(config: unknown): string[]
  execute(config: unknown, ctx: NodeContext): Promise<unknown>
}

export type NodeDefinition = TriggerNodeDefinition | ActionNodeDefinition

export class RetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryableError'
  }
}

export function defineTrigger(def: Omit<TriggerNodeDefinition, 'kind'>): TriggerNodeDefinition {
  return { kind: 'trigger', ...def }
}

export function defineAction<C extends Type.TSchema, O extends Type.TSchema>(def: {
  type: string
  title: string
  description: string
  sideEffect: SideEffect
  configSchema: C
  lenientRefs?: boolean
  roles?: FieldRoles
  ruleIssue?: RuleIssue
  outputSchema: O
  outputSchemaFor?: (config: Type.Static<C>) => Type.TSchema
  validate?: (config: unknown) => string[]
  execute: (config: Type.Static<C>, ctx: NodeContext) => Promise<Type.Static<O>>
}): ActionNodeDefinition {
  return {
    kind: 'action',
    ...def,
    outputSchemaFor: def.outputSchemaFor as ActionNodeDefinition['outputSchemaFor'],
    execute: def.execute as ActionNodeDefinition['execute'],
  }
}
