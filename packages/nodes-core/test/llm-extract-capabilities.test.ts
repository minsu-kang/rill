import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANTHROPIC_CAPABILITIES, LlmError, findModel, type LlmCapabilities, type LlmProvider, type LlmRequest } from '@rill/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RetryableError, llmExtract } from '../src/index'
import { makeCtx } from './helpers'

const fields = [{ name: 'amount', type: 'number' }] as const
const PDF = Buffer.from('%PDF-1.4 TOP-SECRET-DOCUMENT-BODY')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')])
const GIF = Buffer.from('GIF89a rest')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-extract-caps-'))
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function provider(name: string, capabilities: LlmCapabilities | undefined) {
  const requests: LlmRequest[] = []
  const llm: LlmProvider = {
    name,
    ...(capabilities === undefined ? {} : { capabilities }),
    generate: async (request) => {
      requests.push(request)
      return {
        data: { amount: 1 },
        model: 'fake',
        requestedModel: 'fake',
        stopReason: 'end_turn',
        durationMs: 1,
        fallbackUsed: false,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }
    },
  }
  return { llm, requests }
}

const GROK = findModel('grok:grok-4.7')!.capabilities
const GEMINI = findModel('gemini:gemini-3.8-flash')!.capabilities

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a failure')
}

describe('llm.extract and provider capabilities', () => {
  it('refuses a PDF for a provider that reads none, before any request and without file content', async () => {
    const file = join(dir, 'invoice.pdf')
    writeFileSync(file, PDF)
    const { llm, requests } = provider('grok', GROK)
    const error = await failure(llmExtract.execute({ file, fields }, makeCtx({ llm, allowedRoots: [dir] })))
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(error).not.toBeInstanceOf(LlmError)
    expect(error.message).toContain('grok')
    expect(error.message).toContain('PDF')
    expect(error.message).toContain(file)
    expect(error.message).not.toContain('TOP-SECRET')
    expect(requests).toHaveLength(0)
  })

  it('refuses an image type the provider does not take, naming the type and the accepted ones', async () => {
    const file = join(dir, 'anim.gif')
    writeFileSync(file, GIF)
    const { llm, requests } = provider('gemini', GEMINI)
    const error = await failure(llmExtract.execute({ file, fields }, makeCtx({ llm, allowedRoots: [dir] })))
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(error.message).toContain('gemini')
    expect(error.message).toContain('image/gif')
    expect(error.message).toContain('image/png')
    expect(requests).toHaveLength(0)
  })

  it('behaves the same in a dry run', async () => {
    const file = join(dir, 'invoice.pdf')
    writeFileSync(file, PDF)
    const { llm, requests } = provider('grok', GROK)
    const error = await failure(llmExtract.execute({ file, fields }, makeCtx({ llm, allowedRoots: [dir], dryRun: true })))
    expect(error.message).toContain('PDF')
    expect(requests).toHaveLength(0)
  })

  it('refuses a file above the combined request cap', async () => {
    const file = join(dir, 'big.png')
    writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(100, 1)]))
    const { llm, requests } = provider('openai', { ...ANTHROPIC_CAPABILITIES, maxRequestBytes: 50 })
    const error = await failure(llmExtract.execute({ file, fields }, makeCtx({ llm, allowedRoots: [dir] })))
    expect(error).not.toBeInstanceOf(RetryableError)
    expect(error.message).toContain('openai')
    expect(error.message).toContain('50')
    expect(requests).toHaveLength(0)
  })

  it('accepts a file of exactly the request cap and refuses one byte more', async () => {
    const exact = Buffer.concat([PNG, Buffer.alloc(40, 1)])
    const file = join(dir, 'exact.png')
    writeFileSync(file, exact)
    const fits = provider('openai', { ...ANTHROPIC_CAPABILITIES, maxRequestBytes: exact.length })
    await llmExtract.execute({ file, fields }, makeCtx({ llm: fits.llm, allowedRoots: [dir] }))
    expect(fits.requests).toHaveLength(1)
    const tight = provider('openai', { ...ANTHROPIC_CAPABILITIES, maxRequestBytes: exact.length - 1 })
    const error = await failure(llmExtract.execute({ file, fields }, makeCtx({ llm: tight.llm, allowedRoots: [dir] })))
    expect(error.message).toContain(String(exact.length - 1))
    expect(tight.requests).toHaveLength(0)
  })

  it('sends what the provider takes, and text to a provider that reads no PDF', async () => {
    const png = join(dir, 'a.png')
    writeFileSync(png, PNG)
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'Paid 12.50')
    const { llm, requests } = provider('grok', GROK)
    await llmExtract.execute({ file: png, fields }, makeCtx({ llm, allowedRoots: [dir] }))
    await llmExtract.execute({ file: txt, fields }, makeCtx({ llm, allowedRoots: [dir] }))
    await llmExtract.execute({ text: 'inline', fields }, makeCtx({ llm, allowedRoots: [dir] }))
    expect(requests).toHaveLength(3)
  })

  it('keeps working with a provider that declares no capabilities', async () => {
    const file = join(dir, 'invoice.pdf')
    writeFileSync(file, PDF)
    const { llm, requests } = provider('fake', undefined)
    await llmExtract.execute({ file, fields }, makeCtx({ llm, allowedRoots: [dir] }))
    expect(requests).toHaveLength(1)
  })
})
