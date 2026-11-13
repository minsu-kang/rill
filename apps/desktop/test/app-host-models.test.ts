import type { LlmModelsResult } from '@rill/protocol'
import { describe, expect, it, vi } from 'vitest'
import { mergeHostConfigured, withHostConfigured } from '../src/app/glue/host-models'
import type { EngineClient } from '../src/engine/client'
import { models } from '../src/fixtures/plan'

function engineView(configured: readonly string[]): LlmModelsResult {
  return { ...structuredClone(models), providers: models.providers.map((provider) => ({ ...provider, configured: configured.includes(provider.id) })), active: null }
}

function clientOf(result: LlmModelsResult, other: unknown = { time: 1 }): EngineClient & { calls: string[] } {
  const calls: string[] = []
  const client = {
    calls,
    request: vi.fn(async (method: string) => {
      calls.push(method)
      return method === 'llmModels' ? result : other
    }),
    onEvent: vi.fn(() => () => undefined),
  }
  return client as unknown as EngineClient & { calls: string[] }
}

describe('mergeHostConfigured', () => {
  it('marks a provider whose key the host has saved but the engine does not have', () => {
    const merged = mergeHostConfigured(engineView(['anthropic']), ['openai'])
    expect(merged.providers.find((provider) => provider.id === 'openai')?.configured).toBe(true)
    expect(merged.providers.find((provider) => provider.id === 'anthropic')?.configured).toBe(true)
    expect(merged.providers.find((provider) => provider.id === 'gemini')?.configured).toBe(false)
  })

  it('never turns a provider off and keeps the models and the active model', () => {
    const view = engineView(['anthropic', 'openai'])
    const merged = mergeHostConfigured({ ...view, active: { provider: 'anthropic', model: 'claude-opus-5-5' } }, ['gemini'])
    expect(merged.providers.filter((provider) => provider.configured).map((provider) => provider.id).sort()).toEqual(['anthropic', 'gemini', 'openai'])
    expect(merged.active).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(merged.models).toEqual(view.models)
  })

  it('returns the same object when the host has no key and does not change its input', () => {
    const view = engineView(['anthropic'])
    expect(mergeHostConfigured(view, [])).toBe(view)
    const before = structuredClone(view)
    mergeHostConfigured(view, ['openai', 'grok'])
    expect(view).toEqual(before)
  })

  it('ignores a provider id the engine does not list', () => {
    const view = engineView([])
    expect(mergeHostConfigured(view, ['nobody' as never]).providers).toEqual(view.providers)
  })
})

describe('withHostConfigured', () => {
  it('merges only the answer of llmModels and passes every other answer through untouched', async () => {
    const answer = { time: 42 }
    const client = clientOf(engineView([]), answer)
    const wrapped = withHostConfigured(client, ['openai'])
    const models = await wrapped.request('llmModels', {})
    expect(models.providers.find((provider) => provider.id === 'openai')?.configured).toBe(true)
    expect(await wrapped.request('ping', {})).toBe(answer)
    expect(client.calls).toEqual(['llmModels', 'ping'])
  })

  it('returns the same client when the host has no key and forwards events and unsubscribe', () => {
    const client = clientOf(engineView([]))
    expect(withHostConfigured(client, [])).toBe(client)
    const off = vi.fn()
    ;(client.onEvent as ReturnType<typeof vi.fn>).mockReturnValue(off)
    const wrapped = withHostConfigured(client, ['openai'])
    const listener = vi.fn()
    const stop = wrapped.onEvent(listener)
    expect(client.onEvent).toHaveBeenCalledWith(listener)
    stop()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('passes an engine error through', async () => {
    const client = clientOf(engineView([]))
    ;(client.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('engine down'))
    await expect(withHostConfigured(client, ['openai']).request('llmModels', {})).rejects.toThrow('engine down')
  })
})
