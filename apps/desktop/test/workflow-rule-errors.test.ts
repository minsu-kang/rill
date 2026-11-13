// @vitest-environment node
import { RULE_VIOLATION_MESSAGE } from '@rill/engine'
import { RillError } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { ENGINE_RULE_MESSAGE, engineErrorKey } from '../src/app/workflows/errors'
import { en } from '../src/i18n/en'
import { ko } from '../src/i18n/ko'

describe('the error of a workflow that breaks a rule', () => {
  it('uses the message that the engine sends when activation is refused for a rule', () => {
    expect(ENGINE_RULE_MESSAGE).toBe(RULE_VIOLATION_MESSAGE)
  })

  it('has its own text for a refused start of a run', () => {
    const key = engineErrorKey(new RillError('RULE_VIOLATION', RULE_VIOLATION_MESSAGE, ['rule_violation at /nodes/1/type']))
    expect(key).toBe('app.wf.error.RULE_VIOLATION')
    expect(en['app.wf.error.RULE_VIOLATION']).toContain('A rule you set')
    expect(ko['app.wf.error.RULE_VIOLATION']).toContain('규칙')
  })

  it('has the same text for an activation that the engine refused for a rule', () => {
    expect(engineErrorKey(new RillError('ACTIVATION_FAILED', RULE_VIOLATION_MESSAGE))).toBe('app.wf.error.RULE_VIOLATION')
  })

  it('keeps the old text for any other activation failure', () => {
    expect(engineErrorKey(new RillError('ACTIVATION_FAILED', 'the trigger could not be started'))).toBe('app.wf.error.ACTIVATION_FAILED')
    expect(engineErrorKey(new RillError('ACTIVATION_FAILED', `${RULE_VIOLATION_MESSAGE} and more`))).toBe('app.wf.error.ACTIVATION_FAILED')
    expect(engineErrorKey(new RillError('NOT_FOUND', RULE_VIOLATION_MESSAGE))).toBe('app.wf.error.NOT_FOUND')
  })
})
