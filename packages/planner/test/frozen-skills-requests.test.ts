import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCENARIOS, intern, type Frozen } from './frozen/capture'
import { EXPLAIN_SKILLS_SCENARIO, SKILL_SCENARIOS, captureExplainWithSkills, captureSkillsFrozen } from './frozen/capture-skills'

const frozen = JSON.parse(readFileSync(fileURLToPath(new URL('./frozen/skills-requests.json', import.meta.url)), 'utf8')) as Frozen
const before = JSON.parse(readFileSync(fileURLToPath(new URL('./frozen/requests.json', import.meta.url)), 'utf8')) as Frozen

describe('the requests sent for an agent that has skills', () => {
  it('has a golden copy for every scenario and for the explanation', () => {
    expect(Object.keys(frozen.scenarios).sort()).toEqual([...SKILL_SCENARIOS.map((scenario) => scenario.name), EXPLAIN_SKILLS_SCENARIO].sort())
    expect(Object.keys(frozen.texts).length).toBeGreaterThan(3)
  })

  it.each(SKILL_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))('%s', async (name, scenario) => {
    const texts: Record<string, string> = {}
    const now = intern(await scenario.run(), texts)
    expect(now).toEqual(frozen.scenarios[name])
    for (const [id, text] of Object.entries(texts)) expect(frozen.texts[id], id).toBe(text)
  })

  it('the explanation with a repair call', async () => {
    const texts: Record<string, string> = {}
    const now = intern(await captureExplainWithSkills(), texts)
    expect(now).toEqual(frozen.scenarios[EXPLAIN_SKILLS_SCENARIO])
    for (const [id, text] of Object.entries(texts)) expect(frozen.texts[id], id).toBe(text)
  })

  it('captures the same data twice', async () => {
    expect(await captureSkillsFrozen()).toEqual({ texts: frozen.texts, scenarios: frozen.scenarios })
  })

  it('lives next to, and apart from, the golden copy of the requests without an agent', () => {
    for (const name of Object.keys(frozen.scenarios)) expect(Object.keys(before.scenarios), name).not.toContain(name)
    expect(Object.keys(before.scenarios).sort()).toEqual([...SCENARIOS.map((scenario) => scenario.name), 'explain with a repair call'].sort())
  })
})
