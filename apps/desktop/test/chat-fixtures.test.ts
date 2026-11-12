// @vitest-environment node
import { applyPatch } from './patch'
import { createCoreRegistry, validateWorkflow } from '@rill/nodes-core'
import {
  AttachmentRefSchema,
  flagKey,
  LlmModelsResultSchema,
  MemoryItemSchema,
  MEMORY_MAX_CHARS,
  PlanMetaSchema,
  PlanResultBodySchema,
} from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { activeModelOf } from '../src/chat/model/models'
import {
  allAttachmentRefs,
  attachmentRefs,
  flaggedWorkflow,
  memoryFixtures,
  metas,
  models,
  modelsNothingConfigured,
  patchedWorkflow,
  results,
} from '../src/fixtures/plan'
import { workflows } from '../src/fixtures'

const registry = createCoreRegistry()
const STRICT = { registry, allowedRoots: ['/Users/demo'], connections: ['slack-ops', 'slack-team'] }

describe('plan result fixtures', () => {
  it('all pass the protocol schema', () => {
    for (const [name, result] of Object.entries(results)) expect(Value.Check(PlanResultBodySchema, result), name).toBe(true)
  })

  it('has a workflow with no flags, one with one flag of each code, and one with three flags of each code', () => {
    const plain = results.workflow
    expect(plain.kind === 'workflow' && plain.flags).toEqual([])
    expect(plain.kind === 'workflow' && plain.needsConfirmation).toBe(false)
    const flagged = results.flagged
    if (flagged.kind !== 'workflow') throw new Error('workflow expected')
    expect(flagged.needsConfirmation).toBe(true)
    expect(flagged.flags.map((flag) => flag.code).sort()).toEqual(['attachment_origin', 'new_egress_target', 'untrusted_flow'])
    const many = results.manyFlags
    if (many.kind !== 'workflow') throw new Error('workflow expected')
    expect(many.needsConfirmation).toBe(true)
    for (const code of ['attachment_origin', 'new_egress_target', 'untrusted_flow']) expect(many.flags.filter((flag) => flag.code === code)).toHaveLength(3)
    expect(new Set(many.flags.map(flagKey)).size).toBe(many.flags.length)
  })

  it('flags point at nodes of the workflow they belong to', () => {
    for (const result of [results.flagged, results.manyFlags]) {
      if (result.kind !== 'workflow') throw new Error('workflow expected')
      const ids = new Set(result.workflow.nodes.map((node) => node.id))
      for (const flag of result.flags) expect(ids.has(flag.nodeId), flag.nodeId).toBe(true)
    }
  })

  it('has a patch result with all five patch operations', () => {
    const patch = results.patch
    if (patch.kind !== 'workflow') throw new Error('workflow expected')
    expect(patch.patch?.map((op) => op.op).sort()).toEqual(['add_node', 'connect', 'disconnect', 'remove_node', 'set_config'])
  })

  it('has a patch that applied to the original workflow gives the workflow of the result', () => {
    const patch = results.patch
    if (patch.kind !== 'workflow') throw new Error('workflow expected')
    expect(applyPatch(workflows.receipt, patch.patch!)).toEqual(patchedWorkflow)
    expect(patch.workflow).toEqual(patchedWorkflow)
  })

  it('has three questions with defaults and options, one of them free text', () => {
    const questions = results.questions
    if (questions.kind !== 'questions') throw new Error('questions expected')
    expect(questions.questions).toHaveLength(3)
    for (const question of questions.questions) expect(question.default).not.toBe('')
    expect(questions.questions.filter((question) => question.options.length > 0).length).toBeGreaterThanOrEqual(2)
    expect(questions.questions.some((question) => question.options.length === 0)).toBe(true)
    for (const question of questions.questions.filter((item) => item.options.length > 0)) expect(question.options).toContain(question.default)
  })

  it('has an unsupported result with a reason and a nearest idea', () => {
    const unsupported = results.unsupported
    if (unsupported.kind !== 'unsupported') throw new Error('unsupported expected')
    expect(unsupported.reason).not.toBe('')
    expect(unsupported.nearest).not.toBe('')
  })

  it('has workflows that pass the shared validator', () => {
    for (const workflow of [flaggedWorkflow, patchedWorkflow]) expect(validateWorkflow(workflow, STRICT)).toEqual([])
    for (const name of ['workflow', 'manyFlags'] as const) {
      const result = results[name]
      if (result.kind !== 'workflow') throw new Error('workflow expected')
      expect(validateWorkflow(result.workflow, STRICT), name).toEqual([])
    }
  })
})

describe('meta fixtures', () => {
  it('all pass the protocol schema', () => {
    for (const [name, meta] of Object.entries(metas)) expect(Value.Check(PlanMetaSchema, meta), name).toBe(true)
  })

  it('cover the variants the meta line shows', () => {
    expect(metas.collapsed.effortDetail?.collapsed).toBe(true)
    expect(metas.collapsed.effortDetail?.requested).not.toBe(metas.collapsed.effortDetail?.effective)
    expect(metas.nullCost.costUsd).toBeNull()
    expect(metas.memory.memoryUsed).toBeGreaterThan(0)
    expect(metas.memoryDropped.memoryDropped).toBeGreaterThan(0)
    expect(metas.reasoningCapped.reasoningCapped).toBe(true)
    expect(metas.costNote.costNote).toBeTruthy()
    expect(typeof metas.plain.costUsd).toBe('number')
  })
})

describe('model fixtures', () => {
  it('pass the protocol schema', () => {
    expect(Value.Check(LlmModelsResultSchema, models)).toBe(true)
    expect(Value.Check(LlmModelsResultSchema, modelsNothingConfigured)).toBe(true)
  })

  it('has five providers, one of them without a key, and an active model that exists', () => {
    expect(models.providers.map((provider) => provider.id).sort()).toEqual(['anthropic', 'gemini', 'grok', 'meta', 'openai'])
    expect(models.providers.filter((provider) => !provider.configured)).toHaveLength(1)
    expect(activeModelOf(models)).toBeDefined()
    expect(models.models.some((model) => model.provider === models.providers.find((p) => !p.configured)!.id)).toBe(true)
  })

  it('has a model with fewer effort levels and a model with a long data note', () => {
    expect(models.models.some((model) => model.capabilities.effortLevels.length < 5)).toBe(true)
    expect(models.models.some((model) => model.capabilities.dataNote.length > 250)).toBe(true)
  })

  it('has a table with nothing configured and nothing active', () => {
    expect(modelsNothingConfigured.active).toBeNull()
    expect(modelsNothingConfigured.providers.every((provider) => !provider.configured)).toBe(true)
    expect(activeModelOf(modelsNothingConfigured)).toBeUndefined()
  })
})

describe('memory fixtures', () => {
  it('has zero, three and twenty notes that pass the schema, within the limits', () => {
    expect(memoryFixtures.empty).toHaveLength(0)
    expect(memoryFixtures.three).toHaveLength(3)
    expect(memoryFixtures.full).toHaveLength(20)
    for (const item of memoryFixtures.full) {
      expect(Value.Check(MemoryItemSchema, item)).toBe(true)
      expect([...item.text].length).toBeLessThanOrEqual(MEMORY_MAX_CHARS)
      expect(item.text).not.toMatch(/\p{Cc}/u)
    }
    expect(new Set(memoryFixtures.full.map((item) => item.id)).size).toBe(20)
    expect(new Set(memoryFixtures.full.map((item) => item.text.toLowerCase())).size).toBe(20)
  })
})

describe('attachment fixtures', () => {
  it('pass the protocol schema and cover every media type', () => {
    for (const [name, ref] of Object.entries(attachmentRefs)) expect(Value.Check(AttachmentRefSchema, ref), name).toBe(true)
    expect(new Set(allAttachmentRefs.map((ref) => ref.mediaType))).toEqual(
      new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'text/markdown']),
    )
  })

  it('has a hostile name with a bidi override and a control character, and a name at the length limit', () => {
    expect(attachmentRefs.hostile.name).toMatch(/‮/u)
    expect(attachmentRefs.hostile.name).toMatch(/\p{Cc}/u)
    expect(attachmentRefs.long.name.length).toBe(255)
    expect(new Set(allAttachmentRefs.map((ref) => ref.id)).size).toBe(allAttachmentRefs.length)
  })
})
