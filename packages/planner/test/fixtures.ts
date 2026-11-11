import { SCHEMA_VERSION, type PlanIssue, type Workflow } from '@rill/dsl'
import { createCoreRegistry } from '@rill/nodes-core'
import {
  encodeGeneration,
  type AttachmentModule,
  type AttachmentRef,
  type Flag,
  type PlanQuestion,
  type PlanRequest,
  type PlanResultBody,
} from '../src/index'

export interface PrepareCall {
  refs: string[]
  cacheLast: boolean | undefined
}

export const registry = createCoreRegistry()

export const ROOT = '/rill-planner-test-root'

export function receipts(): Workflow {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Receipts',
    nodes: [
      { id: 't1', type: 'trigger.folderWatch@1', config: { folder: `${ROOT}/Receipts`, glob: '*.pdf' } },
      {
        id: 'n1',
        type: 'llm.extract@1',
        config: { file: '{{t1.output.file}}', fields: [{ name: 'amount', type: 'number' }, { name: 'date', type: 'date' }] },
      },
      { id: 'n2', type: 'csv.append@1', config: { file: `${ROOT}/ledger.csv`, row: ['{{n1.output.date}}', '{{n1.output.amount}}'] } },
    ],
    edges: [
      { from: 't1', to: 'n1' },
      { from: 'n1', to: 'n2' },
    ],
  }
}

export function slackWorkflow(): Workflow {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Ping',
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'n1', type: 'notify.slack@1', config: { connection: 'team', text: 'hello' } },
    ],
    edges: [{ from: 't1', to: 'n1' }],
  }
}

export function workflowBody(workflow: Workflow, summary = 'Plan'): PlanResultBody {
  return { kind: 'workflow', workflow, summary, flags: [], needsConfirmation: false }
}

export function workflowData(workflow: Workflow, summary = 'Plan'): unknown {
  return encodeGeneration(workflowBody(workflow, summary))
}

export function questionsData(questions: PlanQuestion[], summary = 'I need to know'): unknown {
  return encodeGeneration({ kind: 'questions', questions, summary })
}

export function question(id: string, options = ['a', 'b'], fallback = options[0]!): PlanQuestion {
  return { id, text: `question ${id}?`, options, default: fallback }
}

export function request(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    text: 'Put my receipts into a ledger',
    turns: [],
    attachments: [],
    effort: 'medium',
    context: { connections: [{ name: 'team', kind: 'slack' }], allowedRoots: [ROOT], attachmentsRoot: `${ROOT}/.attachments` },
    ...overrides,
  }
}

export function ref(id: string, mediaType: AttachmentRef['mediaType'] = 'text/plain'): AttachmentRef {
  return { id, mediaType, name: `${id}.txt`, bytes: 10 }
}

export interface FakeAttachments extends AttachmentModule {
  prepares: PrepareCall[]
  provenanceCalls: Parameters<AttachmentModule['provenance']>[0][]
  redactCalls: PlanIssue[][]
}

export function fakeAttachments(options: { flags?: Flag[]; texts?: Record<string, string>; failWith?: Error } = {}): FakeAttachments {
  const module: FakeAttachments = {
    prepares: [],
    provenanceCalls: [],
    redactCalls: [],
    async prepare(input) {
      module.prepares.push({ refs: input.refs.map((r) => r.id), cacheLast: input.cacheLast })
      if (options.failWith) throw options.failWith
      const texts = input.refs.map((r) => options.texts?.[r.id] ?? `content of ${r.id}`)
      return {
        parts: input.refs.map((r, i) => ({ type: 'text' as const, text: `<attachment>${texts[i]}</attachment>`, ...(input.cacheLast === true && i === input.refs.length - 1 ? { cache: true } : {}) })),
        texts,
      }
    },
    provenance(input) {
      module.provenanceCalls.push(input)
      return options.flags ?? []
    },
    redactIssues(issues, input) {
      module.redactCalls.push(issues)
      const flagged = new Set(input.flags.map((flag) => flag.pointer))
      return issues.map((issue) => (flagged.has(issue.pointer) ? { stage: issue.stage, pointer: issue.pointer, code: issue.code, message: 'redacted' } : issue))
    },
  }
  return module
}
