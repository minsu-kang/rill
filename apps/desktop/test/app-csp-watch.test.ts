import { describe, expect, it } from 'vitest'
import { CSP_ATTRIBUTE, watchCspViolations } from '../src/app/csp-watch'

describe('watchCspViolations', () => {
  it('writes 0 at once and counts each securitypolicyviolation event after it', () => {
    const doc = document.implementation.createHTMLDocument('x')
    const count = watchCspViolations(doc)
    expect(doc.documentElement.getAttribute(CSP_ATTRIBUTE)).toBe('0')
    doc.body.dispatchEvent(new Event('securitypolicyviolation', { bubbles: true }))
    doc.dispatchEvent(new Event('securitypolicyviolation'))
    expect(count()).toBe(2)
    expect(doc.documentElement.getAttribute(CSP_ATTRIBUTE)).toBe('2')
  })

  it('does not count other events', () => {
    const doc = document.implementation.createHTMLDocument('x')
    const count = watchCspViolations(doc)
    doc.dispatchEvent(new Event('error'))
    expect(count()).toBe(0)
  })

  it('uses the attribute name the smoke check reads', () => {
    expect(CSP_ATTRIBUTE).toBe('data-rill-csp-violations')
  })
})
