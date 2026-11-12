// @vitest-environment node
import type { NodeInfo } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { catalog } from '../src/fixtures'
import { badgesOf } from '../src/model/badges'
import { truncate } from '../src/model/text'

const info = (type: string): NodeInfo | undefined => catalog.find((entry) => entry.type === type)

describe('badgesOf', () => {
  it('marks llm.extract as an external transfer', () => {
    expect(badgesOf('llm.extract@1', info('llm.extract@1'))).toEqual(['externalTransfer'])
  })

  it('marks an external side effect as a network call and an idempotent one as a file write', () => {
    expect(badgesOf('http.request@1', info('http.request@1'))).toEqual(['network'])
    expect(badgesOf('notify.slack@1', info('notify.slack@1'))).toEqual(['network'])
    expect(badgesOf('csv.append@1', info('csv.append@1'))).toEqual(['writesFile'])
  })

  it('gives no badge to a pure node, a trigger or an unknown node', () => {
    expect(badgesOf('transform@1', info('transform@1'))).toEqual([])
    expect(badgesOf('condition@1', info('condition@1'))).toEqual([])
    expect(badgesOf('trigger.cron@1', info('trigger.cron@1'))).toEqual([])
    expect(badgesOf('mystery.node@1', undefined)).toEqual([])
  })

  it('still flags an llm node whose catalog entry is missing, and orders the badges the same way every time', () => {
    expect(badgesOf('llm.extract@1', undefined)).toEqual(['externalTransfer'])
    const both: NodeInfo = { ...info('http.request@1')!, type: 'llm.web@1' }
    expect(badgesOf('llm.web@1', both)).toEqual(['externalTransfer', 'network'])
  })
})

describe('truncate', () => {
  it('leaves short text alone and cuts long text with an ellipsis inside the limit', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcde', 5)).toBe('abcde')
    expect(truncate('abcdef', 5)).toBe('abcd…')
    expect(truncate('abcdef', 5)).toHaveLength(5)
  })

  it('does not cut a surrogate pair in half', () => {
    const text = `ab${'😀'.repeat(5)}`
    const cut = truncate(text, 5)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/)
    expect(cut.length).toBeLessThanOrEqual(5)
  })

  it('handles a limit smaller than the ellipsis and the empty string', () => {
    expect(truncate('', 3)).toBe('')
    expect(truncate('abcdef', 1)).toBe('…')
    expect(truncate('abcdef', 0)).toBe('')
  })
})
