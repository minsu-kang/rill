import type { PlanIssue, Workflow } from '@rill/dsl'
import type { JsonSchema, LlmPart, LlmProvider } from '@rill/llm'
import type { NodeRegistry } from '@rill/nodes-core'
import type { RandomHex } from './attachments/prepare'
import type { ProvenanceCache } from './attachments/provenance'
import type { AttachmentRef, Flag, PatchOp, PlanRequest, PlanResult, PlanResultBody } from './types'

export const MAX_ATTACHMENTS_PER_MESSAGE = 5
export const MAX_ATTACHMENTS_PER_CONVERSATION = 10

export interface AttachmentStore {
  read(id: string): Promise<Uint8Array | undefined>
}

export interface PreparedAttachments {
  parts: LlmPart[]
  texts: string[]
}

export interface ProvenanceInput {
  workflow: Workflow
  registry: NodeRegistry
  userTexts: string[]
  existingWorkflow?: Workflow
  attachmentTexts: string[]
  trustedConnections?: readonly string[]
  allowedRoots?: readonly string[]
  cache?: ProvenanceCache
}

export interface RedactInput {
  workflow?: Workflow
  registry: NodeRegistry
  attachmentTexts: string[]
  flags: Flag[]
  userTexts?: string[]
  existingWorkflow?: Workflow
  patch?: readonly PatchOp[]
}

export interface AttachmentModule {
  randomHex?: RandomHex
  prepare(input: { store: AttachmentStore; refs: AttachmentRef[]; cacheLast?: boolean }): Promise<PreparedAttachments>
  provenance(input: ProvenanceInput): Flag[]
  redactIssues(issues: PlanIssue[], input: RedactInput): PlanIssue[]
}

export interface PlannerDeps {
  provider: LlmProvider
  registry: NodeRegistry
  attachmentStore?: AttachmentStore
  attachments?: AttachmentModule
  maxRepairRounds?: number
}

export interface Planner {
  plan(request: PlanRequest): Promise<PlanResult>
}

export interface GenerationCodec {
  schema(registry: NodeRegistry): JsonSchema
  encode(body: PlanResultBody): unknown
}
