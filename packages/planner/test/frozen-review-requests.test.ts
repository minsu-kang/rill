import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Frozen } from './frozen/capture'
import { REVIEW_SCENARIOS, captureReviewFrozen } from './frozen/capture-review'

const frozen = JSON.parse(readFileSync(fileURLToPath(new URL('./frozen/review-requests.json', import.meta.url)), 'utf8')) as Frozen

describe('the requests sent to review a plan', () => {
  it('has a golden copy for every scenario', () => {
    expect(Object.keys(frozen.scenarios).sort()).toEqual(REVIEW_SCENARIOS.map((scenario) => scenario.name).sort())
    expect(Object.keys(frozen.texts).length).toBeGreaterThan(2)
  })

  it('captures the same data as the golden copy, and the same data twice', async () => {
    expect(await captureReviewFrozen()).toEqual({ texts: frozen.texts, scenarios: frozen.scenarios })
    expect(await captureReviewFrozen()).toEqual(await captureReviewFrozen())
  })
})
