import { WorkflowSchema, type Workflow } from '@rill/dsl'
import Type from 'typebox'
import Value from 'typebox/value'

export const CATEGORIES = ['easy', 'ambiguous', 'unsupported', 'attachment', 'patch'] as const
export const ALL_CATEGORIES = [...CATEGORIES, 'memory'] as const
export type Category = (typeof ALL_CATEGORIES)[number]

export const LANGUAGES = ['ko', 'en', 'mixed'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export const ATTACHMENT_KINDS = ['pdf', 'png', 'text'] as const
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number]

export const TAGS = [
  'hard',
  'typo',
  'slang',
  'vague-time',
  'relative-path',
  'mixed-language',
  'two-automations',
  'injection',
  'secret-in-prompt',
  'over-ask',
  'over-refuse',
  'failure-path',
] as const

const strict = { additionalProperties: false } as const

const text = Type.String()
const alternatives = Type.Array(Type.Union([Type.String(), Type.Array(Type.String())]))
const configPattern = Type.Record(Type.String(), Type.Unknown())

export const assertionSchema = Type.Union([
  Type.Object({ check: Type.Literal('hasTrigger'), type: text }, strict),
  Type.Object(
    {
      check: Type.Literal('hasNode'),
      type: text,
      config: Type.Optional(configPattern),
      onError: Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('continue')])),
    },
    strict,
  ),
  Type.Object({ check: Type.Literal('hasNodeCount'), type: text, min: Type.Integer(), max: Type.Integer() }, strict),
  Type.Object({ check: Type.Literal('hasEdge'), fromType: text, toType: text, when: Type.Optional(text) }, strict),
  Type.Object({ check: Type.Literal('orderedBefore'), typeA: text, typeB: text }, strict),
  Type.Object({ check: Type.Literal('extractsFields'), names: alternatives }, strict),
  Type.Object({ check: Type.Literal('noNodeOutsideCatalog') }, strict),
  Type.Object({ check: Type.Literal('noSecretLiteral'), literals: Type.Optional(Type.Array(Type.String())) }, strict),
  Type.Object({ check: Type.Literal('pathInsideAllowedFolders') }, strict),
  Type.Object({ check: Type.Literal('usesConnection'), name: text }, strict),
  Type.Object(
    { check: Type.Literal('hasRetry'), nodeType: text, minAttempts: Type.Optional(Type.Integer()), maxAttempts: Type.Optional(Type.Integer()) },
    strict,
  ),
  Type.Object(
    {
      check: Type.Literal('referencesOutputOf'),
      fromType: text,
      toType: text,
      field: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    },
    strict,
  ),
])

export type Assertion = Type.Static<typeof assertionSchema>
export type AssertionName = Assertion['check']

const workflowBlock = Type.Object({ outcome: Type.Literal('workflow'), assertions: Type.Array(assertionSchema) }, strict)
const questionsBlock = Type.Object({ outcome: Type.Literal('questions'), mustAskAbout: alternatives, maxQuestions: Type.Integer() }, strict)
const unsupportedBlock = Type.Object(
  { outcome: Type.Literal('unsupported'), mustMention: alternatives, mustNotInvent: Type.Array(Type.String()) },
  strict,
)

const alsoAccept = Type.Optional(Type.Array(Type.Union([workflowBlock, questionsBlock, unsupportedBlock])))

export const expectSchema = Type.Union([
  Type.Object({ outcome: Type.Literal('workflow'), assertions: Type.Array(assertionSchema), why: text, alsoAccept }, strict),
  Type.Object({ outcome: Type.Literal('questions'), mustAskAbout: alternatives, maxQuestions: Type.Integer(), why: text, alsoAccept }, strict),
  Type.Object({ outcome: Type.Literal('unsupported'), mustMention: alternatives, mustNotInvent: Type.Array(Type.String()), why: text, alsoAccept }, strict),
])

export type Expectation = Type.Static<typeof expectSchema>
export type ExpectationBlock = Type.Static<typeof workflowBlock> | Type.Static<typeof questionsBlock> | Type.Static<typeof unsupportedBlock>
export type WorkflowBlock = Type.Static<typeof workflowBlock>
export type QuestionsBlock = Type.Static<typeof questionsBlock>
export type UnsupportedBlock = Type.Static<typeof unsupportedBlock>
export type Outcome = ExpectationBlock['outcome']

const attachmentSpecSchema = Type.Object(
  {
    kind: Type.Enum(ATTACHMENT_KINDS),
    fixture: text,
    note: text,
    inject: Type.Optional(text),
  },
  strict,
)

export type AttachmentSpec = Type.Static<typeof attachmentSpecSchema>

const contextSchema = Type.Object(
  {
    connections: Type.Array(text),
    allowedFolders: Type.Array(text),
    existingWorkflow: Type.Optional(WorkflowSchema),
    selectedNodeId: Type.Optional(text),
    attachments: Type.Optional(Type.Array(attachmentSpecSchema)),
    memory: Type.Optional(Type.Array(text)),
  },
  strict,
)

export type CaseContext = Type.Static<typeof contextSchema>

export const caseSchema = Type.Object(
  {
    id: text,
    category: Type.Enum(ALL_CATEGORIES),
    language: Type.Enum(LANGUAGES),
    prompt: text,
    context: contextSchema,
    effort: Type.Enum(EFFORTS),
    tags: Type.Optional(Type.Array(text)),
    expect: expectSchema,
  },
  strict,
)

export type CaseSpec = Type.Static<typeof caseSchema>
export type PlannerEffort = CaseSpec['effort']

export const casesSchema = Type.Array(caseSchema)
export const referencesSchema = Type.Record(Type.String(), WorkflowSchema)
export type References = Record<string, Workflow>

const vocabularySchema = Type.Object(
  { version: Type.Integer(), assertions: Type.Record(Type.String(), Type.Unknown()) },
  { additionalProperties: true },
)
export type Vocabulary = Type.Static<typeof vocabularySchema>

export function schemaProblems(schema: Type.TSchema, input: unknown, limit = 12): string[] {
  if (Value.Check(schema, input)) return []
  return [...Value.Errors(schema, input)].slice(0, limit).map((error) => `${error.instancePath || '/'}: ${error.message}`)
}

export function parseCases(input: unknown): CaseSpec[] {
  const problems = schemaProblems(casesSchema, input)
  if (problems.length > 0) throw new Error(`invalid planner cases:\n${problems.join('\n')}`)
  return input as CaseSpec[]
}

export function parseReferences(input: unknown): References {
  const problems = schemaProblems(referencesSchema, input)
  if (problems.length > 0) throw new Error(`invalid planner references:\n${problems.join('\n')}`)
  return input as References
}

export function parseVocabulary(input: unknown): Vocabulary {
  const problems = schemaProblems(vocabularySchema, input)
  if (problems.length > 0) throw new Error(`invalid planner vocabulary:\n${problems.join('\n')}`)
  return input as Vocabulary
}
