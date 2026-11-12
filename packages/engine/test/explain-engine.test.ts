import { createCoreRegistry } from '@rill/nodes-core'
import { FAILURE_SIGNALS, LIKELY_CAUSES, SUGGESTED_ACTIONS } from '@rill/planner'
import { EXPLAIN_LIKELY_CAUSES, EXPLAIN_SIGNALS, EXPLAIN_SUGGESTED_ACTIONS } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { ExplainBusyError, MAX_CONCURRENT_EXPLAINS, RunNotExplainableError, connectionSecrets, isExplainable } from '../src/explain'
import { LlmUnavailableError } from '../src/plans'
import type { StepDetailRow } from '../src/store'

const registry = createCoreRegistry()

function step(nodeId: string, input: unknown, status: StepDetailRow['status'] = 'succeeded'): StepDetailRow {
  return { nodeId, attempt: 1, status, input, output: null, error: null, startedAt: 1, finishedAt: 2 }
}

const workflow = {
  schemaVersion: 1 as const,
  name: 'w',
  nodes: [
    { id: 't1', type: 'trigger.webhook@1', config: { path: '/hook', secretConnection: 'hook-secret' } },
    { id: 'n1', type: 'http.request@1', config: { url: 'https://api.example.com', auth: { connection: 'api' } } },
    { id: 'n2', type: 'http.request@1', config: { url: 'https://b.example.com', auth: { connection: '{{t1.output.body.name}}' } } },
    { id: 'n3', type: 'notify.slack@1', config: { connection: 'team', text: 'hi' } },
    { id: 'n4', type: 'delay@1', config: { ms: 1 } },
    { id: 'n5', type: 'future.thing@1', config: { connection: 'ghost' } },
  ],
  edges: [],
}

const SECRETS: Record<string, string> = { 'hook-secret': 'HOOK-1111', api: 'API-2222', other: 'OTHER-3333', team: 'https://hooks.example.com/T/B/X', unused: 'UNUSED-4444', ghost: 'GHOST-5555', 'https://api.example.com': 'URL-LOOKALIKE-6666' }

describe('connectionSecrets', () => {
  const resolver = { get: (name: string) => SECRETS[name] }

  it('collects the secrets of the connections that nodes name, a node of an unknown type included, and no other', () => {
    const found = connectionSecrets(workflow, [], registry, resolver)
    expect(found.sort()).toEqual(['API-2222', 'GHOST-5555', 'HOOK-1111', 'https://hooks.example.com/T/B/X'].sort())
  })

  it('looks up only the fields that name a connection, not a url or a text', () => {
    expect(connectionSecrets(workflow, [], registry, resolver)).not.toContain('URL-LOOKALIKE-6666')
  })

  it('finds a connection named through a reference by the input a step resolved', () => {
    const found = connectionSecrets(workflow, [step('n2', { url: 'https://b.example.com', auth: { connection: 'other' } })], registry, resolver)
    expect(found).toContain('OTHER-3333')
  })

  it('reads every attempt of a step', () => {
    const found = connectionSecrets(workflow, [step('n2', { auth: { connection: 'other' } }, 'failed'), step('n2', { auth: { connection: 'unused' } })], registry, resolver)
    expect(found).toEqual(expect.arrayContaining(['OTHER-3333', 'UNUSED-4444']))
  })

  it('leaves out a connection that is not configured and a resolver that throws', () => {
    expect(connectionSecrets(workflow, [], registry, { get: () => undefined })).toEqual([])
    const throwing = { get: (name: string) => { if (name === 'api') throw new Error('keychain locked'); return SECRETS[name] } }
    expect(connectionSecrets(workflow, [], registry, throwing)).not.toContain('API-2222')
    expect(connectionSecrets(workflow, [], registry, throwing)).toContain('HOOK-1111')
  })

  it('adds every connection the engine was told about, whether a node names it or not', () => {
    const found = connectionSecrets(workflow, [], registry, resolver, ['unused', 'other', 'missing'])
    expect(found).toEqual(expect.arrayContaining(['UNUSED-4444', 'OTHER-3333', 'API-2222']))
    expect(found).not.toContain('URL-LOOKALIKE-6666')
    expect(found.filter((secret) => secret === 'OTHER-3333')).toHaveLength(1)
  })

  it('reads the connection of a node whose type the registry does not have from keys called connection', () => {
    const odd = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        { id: 'n6', type: 'future.thing@1', config: { nested: { list: [{ secretConnection: 'hook-secret' }], Connection: 'other' }, note: 'unused' } },
      ],
    }
    const found = connectionSecrets(odd, [step('n6', { auth: { connection: 'unused' }, other: ['x', { CONNECTION: 'api' }] })], registry, resolver)
    expect(found).toEqual(expect.arrayContaining(['GHOST-5555', 'HOOK-1111', 'OTHER-3333', 'UNUSED-4444', 'API-2222']))
    expect(found).not.toContain('URL-LOOKALIKE-6666')
  })

  it('does not take a value under another key for a connection name, also for a node of an unknown type', () => {
    const odd = { ...workflow, nodes: [{ id: 'n6', type: 'future.thing@1', config: { note: 'unused', connectionless: 'other', url: 'https://api.example.com' } }] }
    expect(connectionSecrets(odd, [], registry, resolver)).toEqual([])
  })
})

describe('isExplainable', () => {
  const run = (status: string) => ({ status }) as never
  const steps = (...statuses: StepDetailRow['status'][]) => statuses.map((status) => step('n1', {}, status))

  it('refuses a queued or running run, whatever its steps say', () => {
    expect(isExplainable(run('queued'), [])).toBe(false)
    expect(isExplainable(run('running'), steps('failed'))).toBe(false)
  })

  it('accepts a failed run, with or without steps', () => {
    expect(isExplainable(run('failed'), [])).toBe(true)
    expect(isExplainable(run('failed'), steps('succeeded'))).toBe(true)
  })

  it('accepts a finished run that has a failed, abandoned or continued step', () => {
    for (const status of ['failed', 'abandoned', 'continued'] as const) expect(isExplainable(run('succeeded'), steps('succeeded', status))).toBe(true)
  })

  it('refuses a clean success and a cancelled run without a failed step', () => {
    expect(isExplainable(run('succeeded'), steps('succeeded', 'skipped'))).toBe(false)
    expect(isExplainable(run('cancelled'), steps('succeeded', 'running', 'skipped'))).toBe(false)
    expect(isExplainable(run('succeeded'), [])).toBe(false)
  })
})

describe('the errors', () => {
  it('have fixed texts', () => {
    expect(new RunNotExplainableError().message).toBe('only a finished run that failed or has a failed step can be explained')
    expect(new ExplainBusyError(2).message).toBe('too many explanations are running (at most 2 at a time)')
    expect(new LlmUnavailableError('explaining').message).toBe('no model provider is configured for explaining')
    expect(new LlmUnavailableError().message).toBe('no model provider is configured for planning')
    expect(MAX_CONCURRENT_EXPLAINS).toBe(2)
  })
})

describe('the lists of the protocol', () => {
  it('are the lists of the planner', () => {
    expect([...EXPLAIN_LIKELY_CAUSES]).toEqual([...LIKELY_CAUSES])
    expect([...EXPLAIN_SUGGESTED_ACTIONS]).toEqual([...SUGGESTED_ACTIONS])
    expect([...EXPLAIN_SIGNALS]).toEqual([...FAILURE_SIGNALS])
  })
})
