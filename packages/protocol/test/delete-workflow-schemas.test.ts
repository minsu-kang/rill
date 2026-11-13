import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, METHODS, validateParams } from '../src/index'

describe('deleteWorkflow', () => {
  it('takes a workflow id and nothing else', () => {
    expect(validateParams('deleteWorkflow', { workflowId: 'w' }).ok).toBe(true)
    expect(validateParams('deleteWorkflow', { workflowId: 'x'.repeat(128) }).ok).toBe(true)
  })

  it('rejects an empty or over-long id, a missing id, an unknown field and a wrong type', () => {
    for (const params of [{ workflowId: '' }, { workflowId: 'x'.repeat(129) }, {}, { workflowId: 'w', force: true }, { workflowId: 3 }, { id: 'w' }]) {
      expect(validateParams('deleteWorkflow', params), JSON.stringify(params)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
    }
  })

  it('answers with an empty object', () => {
    expect(Value.Check(METHODS.deleteWorkflow.result, {})).toBe(true)
  })

  it('has its own busy error code, once', () => {
    expect(ERROR_CODES as readonly string[]).toContain('WORKFLOW_BUSY')
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})
