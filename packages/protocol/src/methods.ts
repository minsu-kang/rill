import { WorkflowSchema } from '@rill/dsl'
import Type from 'typebox'
import {
  AGENT_DESCRIPTION_MAX_INPUT_CHARS,
  AGENT_INSTRUCTIONS_MAX_INPUT_CHARS,
  AGENT_MAX_ITEMS,
  AGENT_NAME_MAX_INPUT_CHARS,
  AGENT_PERSONA_MAX_INPUT_CHARS,
  AgentSchema,
} from './agents'
import { ExplainEffortSchema, ExplainResultSchema } from './explain'
import { LlmModelsResultSchema } from './llm'
import { MEMORY_MAX_INPUT_CHARS, MEMORY_MAX_ITEMS, MemoryItemSchema } from './memory'
import {
  AttachmentRefSchema,
  IdSchema,
  PlanEffortSchema,
  PlanIssueSchema,
  PlanMetaSchema,
  PlanRecordSchema,
  PlanResultBodySchema,
  PlanSummarySchema,
  PlanTurnSchema,
} from './plan'
import { RecipeDraftSchema, RecipeInfoSchema, RecipeValuesSchema } from './recipes'
import { RULE_MAX_INPUT_CHARS, RULE_MAX_ITEMS, RuleKindSchema, RuleSchema } from './rules'

const id = IdSchema
const closed = { additionalProperties: false } as const

export const WorkflowSummarySchema = Type.Object({
  id,
  name: Type.String(),
  active: Type.Boolean(),
  triggerType: Type.String(),
  createdAt: Type.Number(),
})

export const RunSummarySchema = Type.Object({
  id,
  workflowId: id,
  status: Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  dryRun: Type.Boolean(),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
})

export const StepDetailSchema = Type.Object({
  nodeId: id,
  attempt: Type.Integer({ minimum: 1 }),
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('abandoned'),
    Type.Literal('skipped'),
    Type.Literal('continued'),
  ]),
  input: Type.Unknown(),
  output: Type.Unknown(),
  error: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Number(),
  finishedAt: Type.Union([Type.Number(), Type.Null()]),
})

export const NodeInfoSchema = Type.Object({
  type: Type.String(),
  kind: Type.Union([Type.Literal('trigger'), Type.Literal('action')]),
  title: Type.String(),
  description: Type.String(),
  sideEffect: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('idempotent'), Type.Literal('external')])),
  configSchema: Type.Unknown(),
  outputSchema: Type.Unknown(),
})

export type WorkflowSummary = Type.Static<typeof WorkflowSummarySchema>
export type RunSummary = Type.Static<typeof RunSummarySchema>
export type StepDetail = Type.Static<typeof StepDetailSchema>
export type NodeInfo = Type.Static<typeof NodeInfoSchema>

const noParams = Type.Object({}, closed)
const noResult = Type.Object({})

export const METHODS = {
  deploy: {
    params: Type.Object({ workflow: Type.Unknown() }, closed),
    result: Type.Object({ workflowId: id }),
  },
  getWorkflow: {
    params: Type.Object({ workflowId: id }, closed),
    result: Type.Object({ workflow: WorkflowSchema }),
  },
  listWorkflows: {
    params: noParams,
    result: Type.Object({ workflows: Type.Array(WorkflowSummarySchema) }),
  },
  startRun: {
    params: Type.Object(
      { workflowId: id, payload: Type.Optional(Type.Unknown()), dryRun: Type.Optional(Type.Boolean()) },
      closed,
    ),
    result: Type.Object({ runId: id }),
  },
  activate: { params: Type.Object({ workflowId: id }, closed), result: noResult },
  deactivate: { params: Type.Object({ workflowId: id }, closed), result: noResult },
  deleteWorkflow: { params: Type.Object({ workflowId: id }, closed), result: noResult },
  listRuns: {
    params: Type.Object(
      { workflowId: Type.Optional(id), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) },
      closed,
    ),
    result: Type.Object({ runs: Type.Array(RunSummarySchema) }),
  },
  getRun: {
    params: Type.Object({ runId: id }, closed),
    result: Type.Object({ run: RunSummarySchema, steps: Type.Array(StepDetailSchema) }),
  },
  nodeCatalog: {
    params: noParams,
    result: Type.Object({ nodes: Type.Array(NodeInfoSchema) }),
  },
  plan: {
    params: Type.Object(
      {
        planId: id,
        text: Type.String({ minLength: 1, maxLength: 8000 }),
        turns: Type.Array(PlanTurnSchema, { maxItems: 40 }),
        attachments: Type.Array(AttachmentRefSchema, { maxItems: 5 }),
        effort: PlanEffortSchema,
        workflowId: Type.Optional(id),
        selection: Type.Optional(Type.Object({ nodeId: id }, closed)),
        useMemory: Type.Optional(Type.Boolean()),
        agentId: Type.Optional(id),
      },
      closed,
    ),
    result: Type.Object({ planId: id, result: PlanResultBodySchema, meta: PlanMetaSchema }),
  },
  cancelPlan: {
    params: Type.Object({ planId: id }, closed),
    result: Type.Object({ cancelled: Type.Boolean() }),
  },
  getPlan: {
    params: Type.Object({ planId: id }, closed),
    result: Type.Object({ plan: PlanRecordSchema }),
  },
  listPlans: {
    params: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, closed),
    result: Type.Object({ plans: Type.Array(PlanSummarySchema) }),
  },
  deployPlan: {
    params: Type.Object({ planId: id, confirmed: Type.Array(Type.String(), { maxItems: 200 }) }, closed),
    result: Type.Object({ workflowId: id }),
  },
  listMemory: {
    params: noParams,
    result: Type.Object({ items: Type.Array(MemoryItemSchema, { maxItems: MEMORY_MAX_ITEMS }) }),
  },
  saveMemory: {
    params: Type.Object({ id: Type.Optional(id), text: Type.String({ maxLength: MEMORY_MAX_INPUT_CHARS }) }, closed),
    result: Type.Object({ item: MemoryItemSchema }),
  },
  deleteMemory: {
    params: Type.Object({ id }, closed),
    result: Type.Object({ deleted: Type.Boolean() }),
  },
  listRules: {
    params: noParams,
    result: Type.Object({ rules: Type.Array(RuleSchema, { maxItems: RULE_MAX_ITEMS }) }),
  },
  saveRule: {
    params: Type.Object({ kind: RuleKindSchema, value: Type.String({ maxLength: RULE_MAX_INPUT_CHARS }) }, closed),
    result: Type.Object({ rule: RuleSchema }),
  },
  deleteRule: {
    params: Type.Object({ id }, closed),
    result: Type.Object({ deleted: Type.Boolean() }),
  },
  checkRules: {
    params: noParams,
    result: Type.Object({
      violations: Type.Array(
        Type.Object({ workflowId: id, name: Type.String(), issues: Type.Array(PlanIssueSchema, { maxItems: 20 }) }, closed),
        { maxItems: 200 },
      ),
    }),
  },
  listAgents: {
    params: noParams,
    result: Type.Object({ agents: Type.Array(AgentSchema, { maxItems: AGENT_MAX_ITEMS + 1 }), activeId: id }, closed),
  },
  saveAgent: {
    params: Type.Object(
      {
        id: Type.Optional(id),
        name: Type.String({ maxLength: AGENT_NAME_MAX_INPUT_CHARS }),
        description: Type.String({ maxLength: AGENT_DESCRIPTION_MAX_INPUT_CHARS }),
        persona: Type.String({ maxLength: AGENT_PERSONA_MAX_INPUT_CHARS }),
        instructions: Type.String({ maxLength: AGENT_INSTRUCTIONS_MAX_INPUT_CHARS }),
      },
      closed,
    ),
    result: Type.Object({ agent: AgentSchema }, closed),
  },
  deleteAgent: {
    params: Type.Object({ id }, closed),
    result: Type.Object({ deleted: Type.Boolean() }),
  },
  setActiveAgent: {
    params: Type.Object({ id }, closed),
    result: noResult,
  },
  explainRun: {
    params: Type.Object({ runId: id, effort: Type.Optional(ExplainEffortSchema), agentId: Type.Optional(id) }, closed),
    result: ExplainResultSchema,
  },
  listRecipes: {
    params: noParams,
    result: Type.Object({ recipes: Type.Array(RecipeInfoSchema) }, closed),
  },
  instantiateRecipe: {
    params: Type.Object({ recipeId: id, values: RecipeValuesSchema }, closed),
    result: RecipeDraftSchema,
  },
  llmModels: { params: noParams, result: LlmModelsResultSchema },
  ping: { params: noParams, result: Type.Object({ time: Type.Number() }) },
} as const

export type MethodName = keyof typeof METHODS
export type MethodParams<M extends MethodName> = Type.Static<(typeof METHODS)[M]['params']>
export type MethodResult<M extends MethodName> = Type.Static<(typeof METHODS)[M]['result']>

export const ERROR_CODES = [
  'INVALID_PARAMS',
  'UNKNOWN_METHOD',
  'INVALID_WORKFLOW',
  'NOT_FOUND',
  'ACTIVATION_FAILED',
  'INTERNAL',
  'LLM_UNAVAILABLE',
  'PLAN_INVALID',
  'PLAN_PROVIDER',
  'PLAN_CANCELLED',
  'PLAN_BUSY',
  'PLAN_EXISTS',
  'PLAN_NOT_CONFIRMED',
  'PLAN_DEPLOYED',
  'ATTACHMENT_REJECTED',
  'MEMORY_INVALID',
  'MEMORY_FULL',
  'MEMORY_DUPLICATE',
  'RULE_INVALID',
  'RULE_FULL',
  'RULE_DUPLICATE',
  'RULE_NOT_FOUND',
  'RULE_VIOLATION',
  'AGENT_INVALID',
  'AGENT_FULL',
  'AGENT_DUPLICATE',
  'AGENT_NOT_FOUND',
  'AGENT_BUILTIN',
  'RUN_NOT_EXPLAINABLE',
  'EXPLAIN_BUSY',
  'EXPLAIN_PROVIDER',
  'EXPLAIN_INVALID',
  'RECIPE_INVALID',
  'WORKFLOW_BUSY',
] as const
