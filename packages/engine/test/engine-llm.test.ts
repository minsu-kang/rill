import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError, type LlmProvider, type LlmRequest } from '@rill/llm'
import { createCoreRegistry } from '@rill/nodes-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import type { EngineEvent } from '../src/events'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-llm-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeLlm(replies: unknown[]) {
  const requests: LlmRequest[] = []
  const llm: LlmProvider = {
    name: 'fake',
    generate: async (request) => {
      requests.push(request)
      const next = replies.shift()
      if (next instanceof Error) throw next
      return {
        data: next,
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

function setup(llm: LlmProvider | undefined) {
  const events: EngineEvent[] = []
  const engine = new Engine({
    db: Db.open(':memory:'),
    registry: createCoreRegistry(),
    allowedRoots: [dir],
    sleep: async () => {},
    random: () => 1,
    llm,
  })
  engine.on((event) => events.push(event))
  return { engine, events }
}

function receiptWorkflow(csv: string, retry?: { maxAttempts: number }) {
  return {
    schemaVersion: 1,
    name: 'receipt',
    nodes: [
      { id: 't1', type: 'trigger.manual@1', config: {} },
      { id: 'read', type: 'file.read@1', config: { path: '{{t1.output.path}}' } },
      {
        id: 'ex',
        type: 'llm.extract@1',
        config: {
          file: '{{read.output.path}}',
          fields: [
            { name: 'amount', type: 'number' },
            { name: 'date', type: 'date' },
          ],
        },
        ...(retry ? { retry } : {}),
      },
      { id: 'out', type: 'csv.append@1', config: { file: csv, row: ['{{ex.output.date}}', '{{ex.output.amount}}'] } },
    ],
    edges: [
      { from: 't1', to: 'read' },
      { from: 'read', to: 'ex' },
      { from: 'ex', to: 'out' },
    ],
  }
}

function writeReceipt(): string {
  const file = join(dir, 'receipt.pdf')
  writeFileSync(file, Buffer.from('%PDF-1.4 fake'))
  return file
}

describe('Engine with an LLM provider', () => {
  it('runs llm.extract between file.read and csv.append', async () => {
    const csv = join(dir, 'out.csv')
    const { llm, requests } = fakeLlm([{ amount: 12.5, date: '2026-11-11' }])
    const { engine } = setup(llm)
    const id = engine.deploy(receiptWorkflow(csv))
    const result = await engine.startRun(id, { path: writeReceipt() })
    expect(result.status).toBe('succeeded')
    expect(readFileSync(csv, 'utf8')).toBe('2026-11-11,12.5\n')
    expect(requests).toHaveLength(1)
    const content = requests[0]!.messages[0]!.content as Array<{ type: string }>
    expect(content[0]!.type).toBe('document')
    expect(result.outputs.ex).toEqual({ amount: 12.5, date: '2026-11-11' })
  })

  it('fails the run with a clear message when no provider is configured', async () => {
    const { engine } = setup(undefined)
    const id = engine.deploy(receiptWorkflow(join(dir, 'out.csv')))
    const result = await engine.startRun(id, { path: writeReceipt() })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('llm.extract needs an LLM provider')
  })

  it('retries a transient provider error under the node retry setting', async () => {
    const csv = join(dir, 'out.csv')
    const { llm, requests } = fakeLlm([new LlmError('rate_limit', 'slow down'), { amount: 3, date: '2026-01-02' }])
    const { engine, events } = setup(llm)
    const id = engine.deploy(receiptWorkflow(csv, { maxAttempts: 2 }))
    const result = await engine.startRun(id, { path: writeReceipt() })
    expect(result.status).toBe('succeeded')
    expect(requests).toHaveLength(2)
    expect(events.find((e) => e.type === 'step.failed')).toMatchObject({ nodeId: 'ex', willRetry: true, error: 'slow down' })
    expect(readFileSync(csv, 'utf8')).toBe('2026-01-02,3\n')
  })

  it('does not retry a permanent provider error', async () => {
    const { llm, requests } = fakeLlm([new LlmError('refusal', 'the model declined this request'), { amount: 1, date: '2026-01-02' }])
    const { engine } = setup(llm)
    const id = engine.deploy(receiptWorkflow(join(dir, 'out.csv'), { maxAttempts: 3 }))
    const result = await engine.startRun(id, { path: writeReceipt() })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('the model declined this request')
    expect(requests).toHaveLength(1)
  })

  it('rejects structural mistakes of llm.extract at deploy time', () => {
    const { engine } = setup(undefined)
    const base = receiptWorkflow(join(dir, 'out.csv'))
    const withConfig = (config: Record<string, unknown>) => ({
      ...base,
      nodes: base.nodes.map((node) => (node.id === 'ex' ? { ...node, config } : node)),
    })
    const duplicate = { file: '{{read.output.path}}', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] }
    expect(() => engine.deploy(withConfig(duplicate))).toThrow('node ex: duplicate field name: a')
    expect(() => engine.deploy(withConfig({ fields: [{ name: 'a', type: 'string' }] }))).toThrow(
      'node ex: llm.extract needs exactly one of file or text',
    )
    expect(() => engine.deploy(base)).not.toThrow()
  })

  it('still extracts in a dry run but does not write the CSV', async () => {
    const csv = join(dir, 'out.csv')
    const { llm, requests } = fakeLlm([{ amount: 9, date: '2026-03-04' }])
    const { engine } = setup(llm)
    const id = engine.deploy(receiptWorkflow(csv))
    const result = await engine.startRun(id, { path: writeReceipt() }, { dryRun: true })
    expect(result.status).toBe('succeeded')
    expect(requests).toHaveLength(1)
    expect(result.outputs.ex).toEqual({ amount: 9, date: '2026-03-04' })
    expect(existsSync(csv)).toBe(false)
  })
})
