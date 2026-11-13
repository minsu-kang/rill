import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCENARIOS, captureExplain, captureFrozen, intern, type Frozen } from './frozen/capture'

const frozen = JSON.parse(readFileSync(fileURLToPath(new URL('./frozen/requests.json', import.meta.url)), 'utf8')) as Frozen

describe('the requests sent without an agent are what they were before agents existed', () => {
  it('has a frozen copy for every scenario and for the explanation', () => {
    expect(Object.keys(frozen.scenarios).sort()).toEqual([...SCENARIOS.map((scenario) => scenario.name), 'explain with a repair call'].sort())
    expect(Object.keys(frozen.texts).length).toBeGreaterThan(5)
  })

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))('%s', async (name, scenario) => {
    const texts: Record<string, string> = {}
    const now = intern(await scenario.run(), texts)
    expect(now).toEqual(frozen.scenarios[name])
    for (const [id, text] of Object.entries(texts)) expect(frozen.texts[id], id).toBe(text)
  })

  it('the explanation with a repair call', async () => {
    const texts: Record<string, string> = {}
    const now = intern(await captureExplain(), texts)
    expect(now).toEqual(frozen.scenarios['explain with a repair call'])
    for (const [id, text] of Object.entries(texts)) expect(frozen.texts[id], id).toBe(text)
  })

  it('captures the same data twice', async () => {
    expect(await captureFrozen()).toEqual({ texts: frozen.texts, scenarios: frozen.scenarios })
  })
})
