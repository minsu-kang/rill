import { ANTHROPIC_CAPABILITIES, EFFORT_LEVELS, findModel, listModels, type LlmCapabilities, type LlmEffort } from '@rill/llm'
import { describe, expect, it } from 'vitest'
import { AttachmentError, EFFORT_BUDGETS, PlanError, SOFT_CAP_HEADROOM, createPlanner, resolveEffort } from '../src/index'
import { GIF, PDF, PNG, WEBP, refOf, storeOf } from './attachments/helpers'
import { FakeProvider } from './fake-provider'
import { receipts, registry, request, workflowData } from './fixtures'

const caps = (spec: string): LlmCapabilities => findModel(spec)!.capabilities

const ORDER: readonly LlmEffort[] = EFFORT_LEVELS

describe('resolveEffort', () => {
  it('keeps every level for the Anthropic defaults', () => {
    for (const level of ORDER) {
      expect(resolveEffort(ANTHROPIC_CAPABILITIES, level)).toEqual({ effective: level, native: level, collapsed: false })
    }
  })

  it('collapses xhigh and max to high on Gemini and reports the native value', () => {
    const gemini = caps('gemini:gemini-3.8-flash')
    expect(resolveEffort(gemini, 'medium')).toEqual({ effective: 'medium', native: 'medium', collapsed: false })
    expect(resolveEffort(gemini, 'xhigh')).toEqual({ effective: 'high', native: 'high', collapsed: true })
    expect(resolveEffort(gemini, 'max')).toEqual({ effective: 'high', native: 'high', collapsed: true })
  })

  it('collapses max to xhigh on Grok 4.7 and xhigh to high on Grok 4.5', () => {
    expect(resolveEffort(caps('grok:grok-4.7'), 'max')).toEqual({ effective: 'xhigh', native: 'xhigh', collapsed: true })
    expect(resolveEffort(caps('grok:grok-4.7'), 'xhigh')).toEqual({ effective: 'xhigh', native: 'xhigh', collapsed: false })
    expect(resolveEffort(caps('grok:grok-4.5'), 'xhigh')).toEqual({ effective: 'high', native: 'high', collapsed: true })
  })

  it('clamps max to xhigh on Muse Spark 1.2 and keeps it on Spark 1.3', () => {
    expect(resolveEffort(caps('meta:muse-spark-1.2'), 'max')).toEqual({ effective: 'xhigh', native: 'xhigh', collapsed: true })
    expect(resolveEffort(caps('meta:muse-spark-1.3'), 'max')).toEqual({ effective: 'max', native: 'max', collapsed: false })
  })

  it('raises a level below every distinguished level to the lowest one', () => {
    const only = { ...ANTHROPIC_CAPABILITIES, effortLevels: ['medium', 'high'] as const, effortMap: { ...ANTHROPIC_CAPABILITIES.effortMap, low: 'medium' } }
    expect(resolveEffort(only, 'low')).toEqual({ effective: 'medium', native: 'medium', collapsed: true })
  })

  it('treats a model with no distinguished levels as keeping the request', () => {
    const none = { ...ANTHROPIC_CAPABILITIES, effortLevels: [] }
    expect(resolveEffort(none, 'high')).toEqual({ effective: 'high', native: 'high', collapsed: false })
  })

  it('is the highest distinguished level at or below the request, for every model in the registry', () => {
    for (const model of listModels()) {
      const { capabilities } = model
      for (const level of ORDER) {
        const result = resolveEffort(capabilities, level)
        const label = `${model.provider}:${model.id} ${level}`
        expect(capabilities.effortLevels, label).toContain(result.effective)
        expect(result.native, label).toBe(capabilities.effortMap[level])
        expect(result.native, label).toBe(capabilities.effortMap[result.effective])
        expect(result.collapsed, label).toBe(result.effective !== level)
        expect(ORDER.indexOf(result.effective), label).toBeLessThanOrEqual(ORDER.indexOf(level))
        const better = capabilities.effortLevels.filter((candidate) => ORDER.indexOf(candidate) > ORDER.indexOf(result.effective) && ORDER.indexOf(candidate) <= ORDER.indexOf(level))
        expect(better, label).toEqual([])
      }
    }
  })
})

const GROK = caps('grok:grok-4.7')
const GEMINI = caps('gemini:gemini-3.8-flash')
const OPENAI = caps('openai:gpt-6.1-sol')

const planned = () => [{ data: workflowData(receipts()) }]

async function planError(promise: Promise<unknown>): Promise<PlanError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlanError) return error
    throw error
  }
  throw new Error('expected a PlanError')
}

function countingStore(files: Record<string, Uint8Array>) {
  const reads: string[] = []
  const inner = storeOf(files)
  return {
    reads,
    store: {
      read: async (id: string) => {
        reads.push(id)
        return inner.read(id)
      },
    },
  }
}

const SECRET = 'TOP-SECRET-FILE-CONTENT-9137'
const secretPdf = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.from(SECRET)])

describe('the planner and provider capabilities: attachments', () => {
  it('rejects a PDF for a provider that reads none, before any read or request', async () => {
    const provider = new FakeProvider(planned(), { name: 'grok', capabilities: GROK })
    const { store, reads } = countingStore({ a: secretPdf })
    const error = await planError(
      createPlanner({ provider, registry, attachmentStore: store }).plan(request({ attachments: [refOf('a', 'application/pdf', 'invoice.pdf')] })),
    )
    expect(error.kind).toBe('attachment')
    expect(error.cause).toBeInstanceOf(AttachmentError)
    expect((error.cause as AttachmentError).code).toBe('unsupported_media')
    expect(error.message).toContain('grok')
    expect(error.message).toContain('PDF')
    expect(error.message).toContain('invoice.pdf')
    expect(error.message).not.toContain(SECRET)
    expect(provider.calls).toHaveLength(0)
    expect(reads).toEqual([])
  })

  it('rejects a PDF attached in an earlier turn the same way', async () => {
    const provider = new FakeProvider(planned(), { name: 'grok', capabilities: GROK })
    const turns = [
      { role: 'user' as const, text: 'first', attachments: [refOf('a', 'application/pdf', 'old.pdf')] },
      { role: 'assistant' as const, text: 'ok' },
    ]
    const error = await planError(createPlanner({ provider, registry, attachmentStore: storeOf({ a: secretPdf }) }).plan(request({ turns })))
    expect((error.cause as AttachmentError).code).toBe('unsupported_media')
    expect(provider.calls).toHaveLength(0)
  })

  it('rejects an image type outside the list and names the type and what is accepted', async () => {
    const provider = new FakeProvider(planned(), { name: 'gemini', capabilities: GEMINI })
    const error = await planError(
      createPlanner({ provider, registry, attachmentStore: storeOf({ g: GIF }) }).plan(request({ attachments: [refOf('g', 'image/gif', 'anim.gif')] })),
    )
    expect((error.cause as AttachmentError).code).toBe('unsupported_media')
    expect(error.message).toContain('gemini')
    expect(error.message).toContain('image/gif')
    expect(error.message).toContain('image/png')
    expect(error.message).toContain('image/webp')
    expect(provider.calls).toHaveLength(0)
  })

  it('lets through the types a provider takes', async () => {
    const provider = new FakeProvider(planned(), { name: 'gemini', capabilities: GEMINI })
    const result = await createPlanner({ provider, registry, attachmentStore: storeOf({ p: PDF, w: WEBP }) }).plan(
      request({ attachments: [refOf('p', 'application/pdf'), refOf('w', 'image/webp')] }),
    )
    expect(result.kind).toBe('workflow')
    expect(provider.calls).toHaveLength(1)
  })

  it('does not look at text attachments', async () => {
    const provider = new FakeProvider(planned(), { name: 'grok', capabilities: GROK })
    const result = await createPlanner({ provider, registry, attachmentStore: storeOf({ t: new TextEncoder().encode('hello') }) }).plan(
      request({ attachments: [refOf('t', 'text/plain')] }),
    )
    expect(result.kind).toBe('workflow')
  })

  it('fails when the binary attachments of the whole conversation exceed the request cap, before any request', async () => {
    const provider = new FakeProvider(planned(), { name: 'openai', capabilities: { ...OPENAI, maxRequestBytes: 150 } })
    const big = Buffer.concat([PNG, Buffer.alloc(100, 1)])
    const turns = [
      { role: 'user' as const, text: 'first', attachments: [refOf('a', 'image/png', 'a.png')] },
      { role: 'assistant' as const, text: 'ok' },
    ]
    const error = await planError(
      createPlanner({ provider, registry, attachmentStore: storeOf({ a: big, b: big }) }).plan(request({ turns, attachments: [refOf('b', 'image/png', 'b.png')] })),
    )
    expect(error.kind).toBe('attachment')
    expect((error.cause as AttachmentError).code).toBe('too_large')
    expect(error.message).toContain('openai')
    expect(error.message).toContain('150')
    expect(provider.calls).toHaveLength(0)
  })

  it('passes when the attachments fit under the cap exactly', async () => {
    const png = Buffer.concat([PNG, Buffer.alloc(50, 1)])
    const provider = new FakeProvider(planned(), { name: 'openai', capabilities: { ...OPENAI, maxRequestBytes: png.length * 2 } })
    const result = await createPlanner({ provider, registry, attachmentStore: storeOf({ a: png, b: png }) }).plan(
      request({ attachments: [refOf('a', 'image/png'), refOf('b', 'image/png')] }),
    )
    expect(result.kind).toBe('workflow')
  })

  it('does not count text attachments against the binary cap', async () => {
    const provider = new FakeProvider(planned(), { name: 'openai', capabilities: { ...OPENAI, maxRequestBytes: 10 } })
    const result = await createPlanner({ provider, registry, attachmentStore: storeOf({ t: new TextEncoder().encode('a long text attachment that is more than ten bytes') }) }).plan(
      request({ attachments: [refOf('t', 'text/plain')] }),
    )
    expect(result.kind).toBe('workflow')
  })

  it('keeps working with a provider that declares no capabilities (the Anthropic defaults)', async () => {
    const provider = new FakeProvider(planned())
    const result = await createPlanner({ provider, registry, attachmentStore: storeOf({ p: PDF }) }).plan(request({ attachments: [refOf('p', 'application/pdf')] }))
    expect(result.kind).toBe('workflow')
  })
})

describe('the planner and provider capabilities: effort', () => {
  it('sends the effective level with its budget and reports requested, effective and collapsed', async () => {
    const provider = new FakeProvider(planned(), { name: 'gemini', capabilities: GEMINI })
    const result = await createPlanner({ provider, registry }).plan(request({ effort: 'xhigh' }))
    const call = provider.calls[0]!
    expect(call.request.effort).toBe('high')
    expect(call.request.maxTokens).toBe(EFFORT_BUDGETS.high.maxTokens)
    expect(call.options?.timeoutMs).toBe(EFFORT_BUDGETS.high.timeoutMs)
    expect(result.effort).toBe('xhigh')
    expect(result.meta.effort).toEqual({ requested: 'xhigh', effective: 'high', native: 'high', collapsed: true })
  })

  it('reports an uncollapsed level for the Anthropic defaults', async () => {
    const provider = new FakeProvider(planned())
    const result = await createPlanner({ provider, registry }).plan(request({ effort: 'max' }))
    expect(provider.calls[0]!.request.effort).toBe('max')
    expect(result.meta.effort).toEqual({ requested: 'max', effective: 'max', native: 'max', collapsed: false })
    expect(result.meta.provider).toBe('fake')
  })

  it('adds time headroom and a soft-cap note when hidden reasoning is not capped by max tokens', async () => {
    const provider = new FakeProvider(planned(), { name: 'grok', capabilities: GROK })
    const result = await createPlanner({ provider, registry }).plan(request({ effort: 'high' }))
    const call = provider.calls[0]!
    expect(call.request.maxTokens).toBe(EFFORT_BUDGETS.high.maxTokens)
    expect(call.options?.timeoutMs).toBe(EFFORT_BUDGETS.high.timeoutMs * SOFT_CAP_HEADROOM)
    expect(result.meta.reasoningCapped).toBe(false)
    expect(result.meta.costNote).toMatch(/soft/i)
  })

  it('leaves the timeout and the note alone when reasoning is capped', async () => {
    const provider = new FakeProvider(planned(), { name: 'openai', capabilities: OPENAI })
    const result = await createPlanner({ provider, registry }).plan(request({ effort: 'high' }))
    expect(provider.calls[0]!.options?.timeoutMs).toBe(EFFORT_BUDGETS.high.timeoutMs)
    expect(result.meta.reasoningCapped).toBe(true)
    expect(result.meta.costNote).toBeUndefined()
  })

  it('applies the effective level to every repair round', async () => {
    const outside = receipts()
    outside.nodes[2]!.config = { file: '/elsewhere/ledger.csv', row: ['{{n1.output.date}}'] }
    const provider = new FakeProvider([{ data: workflowData(outside) }, { data: workflowData(receipts()) }], { name: 'gemini', capabilities: GEMINI })
    await createPlanner({ provider, registry }).plan(request({ effort: 'max' }))
    expect(provider.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of provider.calls) {
      expect(call.request.effort).toBe('high')
      expect(call.options?.timeoutMs).toBe(EFFORT_BUDGETS.high.timeoutMs)
    }
  })
})
