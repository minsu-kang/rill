import { describe, expect, it } from 'vitest'
import {
  METHODS,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  errorResponse,
  okResponse,
  parseEvent,
  parseRequest,
  parseServerMessage,
  tokenFromProtocols,
  tokenProtocol,
  validateParams,
} from '../src/index'

describe('parseRequest', () => {
  it('accepts a well-formed request', () => {
    const raw = JSON.stringify({ type: 'request', id: '1', method: 'ping', params: {} })
    expect(parseRequest(raw)).toEqual({ ok: true, value: { type: 'request', id: '1', method: 'ping', params: {} } })
  })

  it('accepts a request without params', () => {
    expect(parseRequest(JSON.stringify({ type: 'request', id: '7', method: 'ping' })).ok).toBe(true)
  })

  it('rejects invalid JSON and bad envelopes', () => {
    const bad = [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ type: 'request', id: '', method: 'ping' }),
      JSON.stringify({ type: 'request', id: 'x'.repeat(65), method: 'ping' }),
      JSON.stringify({ type: 'request', id: '1', method: 'm'.repeat(65) }),
      JSON.stringify({ type: 'request', id: '1', method: '' }),
      JSON.stringify({ type: 'request', id: '1', method: 'ping', extra: 1 }),
      JSON.stringify({ type: 'response', id: '1' }),
    ]
    for (const raw of bad) expect(parseRequest(raw).ok).toBe(false)
  })
})

describe('validateParams', () => {
  it('treats missing params as an empty object', () => {
    expect(validateParams('ping', undefined)).toEqual({ ok: true, method: 'ping', params: {} })
    expect(validateParams('listWorkflows', undefined).ok).toBe(true)
  })

  it('accepts valid params and keeps the value', () => {
    expect(validateParams('startRun', { workflowId: 'w', payload: { a: 1 }, dryRun: true })).toEqual({
      ok: true,
      method: 'startRun',
      params: { workflowId: 'w', payload: { a: 1 }, dryRun: true },
    })
  })

  it('rejects unknown methods, including inherited property names', () => {
    expect(validateParams('nope', {})).toMatchObject({ ok: false, code: 'UNKNOWN_METHOD' })
    expect(validateParams('toString', {})).toMatchObject({ ok: false, code: 'UNKNOWN_METHOD' })
    expect(validateParams('constructor', {})).toMatchObject({ ok: false, code: 'UNKNOWN_METHOD' })
  })

  it('lists every problem for invalid params', () => {
    const result = validateParams('startRun', { workflowId: '', dryRun: 'yes' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PARAMS')
      expect(result.problems.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('rejects unknown properties and out-of-range limits', () => {
    expect(validateParams('ping', { extra: 1 }).ok).toBe(false)
    expect(validateParams('listRuns', { limit: 0 }).ok).toBe(false)
    expect(validateParams('listRuns', { limit: 201 }).ok).toBe(false)
    expect(validateParams('listRuns', { limit: 200, workflowId: 'w' }).ok).toBe(true)
  })
})

describe('parseServerMessage', () => {
  it('accepts hello, responses and events', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION })).ok).toBe(true)
    expect(parseServerMessage(JSON.stringify(okResponse('1', { time: 5 }))).ok).toBe(true)
    expect(
      parseServerMessage(
        JSON.stringify(errorResponse('1', { code: 'INVALID_WORKFLOW', message: 'bad', problems: ['a', 'b'] })),
      ).ok,
    ).toBe(true)
    const event = { type: 'workflow.activated', at: 1, workflowId: 'w' }
    expect(parseServerMessage(JSON.stringify({ type: 'event', event })).ok).toBe(true)
  })

  it('leaves the protocol number and the event payload to the caller', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'hello', protocol: 2 })).ok).toBe(true)
    expect(parseServerMessage(JSON.stringify({ type: 'event', event: { type: 'run.cancelled' } })).ok).toBe(true)
  })

  it('rejects unknown envelope types and malformed responses', () => {
    const bad = [
      JSON.stringify({ type: 'hello', protocol: 'one' }),
      JSON.stringify({ type: 'greeting' }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ type: 'response', id: '1', ok: true }),
      JSON.stringify({ type: 'response', id: '1', ok: false, error: { code: 'X' } }),
      '{',
    ]
    for (const raw of bad) expect(parseServerMessage(raw).ok).toBe(false)
  })
})

describe('parseEvent', () => {
  it('returns a known event and drops anything else', () => {
    const event = { type: 'workflow.activated', at: 1, workflowId: 'w' }
    expect(parseEvent(event)).toEqual(event)
    expect(parseEvent({ type: 'run.cancelled', at: 1 })).toBeUndefined()
    expect(parseEvent({ ...event, extra: true })).toBeUndefined()
    expect(parseEvent(null)).toBeUndefined()
  })
})

describe('token subprotocol', () => {
  it('round-trips a token', () => {
    expect(tokenProtocol('abc.def')).toBe('rill.token.abc.def')
    expect(tokenFromProtocols([SUBPROTOCOL, tokenProtocol('abc.def')])).toBe('abc.def')
  })

  it('returns undefined when no token is offered', () => {
    expect(tokenFromProtocols([SUBPROTOCOL])).toBeUndefined()
    expect(tokenFromProtocols([])).toBeUndefined()
    expect(tokenFromProtocols(['rill.token.'])).toBeUndefined()
  })
})

describe('METHODS', () => {
  it('declares every method with params and result schemas', () => {
    expect(Object.keys(METHODS).sort()).toEqual(
      [
        'activate',
        'cancelPlan',
        'checkRules',
        'deactivate',
        'deleteAgent',
        'deleteHook',
        'deleteMemory',
        'deleteRule',
        'deleteSkill',
        'deleteWorkflow',
        'deploy',
        'deployPlan',
        'explainRun',
        'getPlan',
        'getRun',
        'getWorkflow',
        'instantiateRecipe',
        'listAgents',
        'listHookLog',
        'listHooks',
        'listMemory',
        'listPlans',
        'listRecipes',
        'listRules',
        'listRuns',
        'listSkills',
        'listWorkflows',
        'llmModels',
        'nodeCatalog',
        'ping',
        'plan',
        'reviewPlan',
        'saveAgent',
        'saveHook',
        'saveMemory',
        'saveRule',
        'saveSkill',
        'setActiveAgent',
        'startRun',
      ].sort(),
    )
    for (const method of Object.values(METHODS)) {
      expect(method.params).toBeDefined()
      expect(method.result).toBeDefined()
    }
  })
})
