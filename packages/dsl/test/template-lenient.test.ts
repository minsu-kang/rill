import { describe, expect, it } from 'vitest'
import { TemplateError, resolveTemplates } from '../src/template'

const outputs = { t1: { name: 'a' } }

describe('resolveTemplates lenient mode', () => {
  it('turns a missing whole-string reference into undefined', () => {
    expect(resolveTemplates('{{t1.output.email}}', outputs, { lenient: true })).toBeUndefined()
    expect(resolveTemplates('{{ghost.output.x}}', outputs, { lenient: true })).toBeUndefined()
  })

  it('turns a missing reference inside text into an empty string', () => {
    expect(resolveTemplates('mail: {{t1.output.email}}!', outputs, { lenient: true })).toBe('mail: !')
  })

  it('still resolves what exists, including nested values', () => {
    expect(
      resolveTemplates({ a: ['{{t1.output.name}}', '{{t1.output.email}}'] }, outputs, { lenient: true }),
    ).toEqual({ a: ['a', undefined] })
  })

  it('stays strict by default', () => {
    expect(() => resolveTemplates('{{t1.output.email}}', outputs)).toThrow(TemplateError)
    expect(() => resolveTemplates('{{t1.output.email}}', outputs, {})).toThrow(TemplateError)
  })
})
