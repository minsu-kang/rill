// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@rill/protocol')
  vi.doUnmock('../src/app/agents/skill-file')
  vi.resetModules()
})

async function textsWithLimits() {
  vi.resetModules()
  vi.doMock('@rill/protocol', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@rill/protocol')>()),
    SKILL_MAX_ITEMS: 31,
    AGENT_MAX_SKILLS: 7,
    AGENT_SKILLS_MAX_CHARS: 5321,
    SKILL_FIELD_LIMITS: { name: 41, description: 123, body: 3210 },
  }))
  vi.doMock('../src/app/agents/skill-file', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/app/agents/skill-file')>()), SKILL_FILE_MAX_BYTES: 48 * 1024 }))
  const [{ skillsEn }, { skillsKo }] = await Promise.all([import('../src/i18n/skills.en'), import('../src/i18n/skills.ko')])
  return { en: skillsEn, ko: skillsKo }
}

describe('the fixed texts about the limits of skills', () => {
  it('take the numbers from the protocol, so a changed limit cannot leave a wrong text behind', async () => {
    const { en, ko } = await textsWithLimits()
    expect(en['skills.error.SKILL_FULL']).toContain('31 skills')
    expect(ko['skills.error.SKILL_FULL']).toContain('31개')
    expect(en['skills.error.agentSkillsTooMany']).toContain('7 skills')
    expect(ko['skills.error.agentSkillsTooMany']).toContain('7개')
    expect(en['skills.error.agentSkillsTooLarge']).toContain('5,321 characters')
    expect(ko['skills.error.agentSkillsTooLarge']).toContain('5321자')
    expect(en['skills.error.tooLargeForAgent']).toContain('5,321 characters')
    expect(ko['skills.error.tooLargeForAgent']).toContain('5321자')
    expect(en['skills.field.name.hint']).toContain('1 to 41 characters')
    expect(ko['skills.field.name.hint']).toContain('1~41자')
    expect(en['skills.field.description.hint']).toContain('up to 123 characters')
    expect(ko['skills.field.description.hint']).toContain('123자까지')
    expect(en['skills.field.body.hint']).toContain('1 to 3210 characters')
    expect(ko['skills.field.body.hint']).toContain('1~3210자')
    expect(en['skills.file.problem.too_large']).toContain('48 KiB')
    expect(ko['skills.file.problem.too_large']).toContain('48KiB')
  })

  it('keep none of the old numbers', async () => {
    const { en, ko } = await textsWithLimits()
    const keys = ['skills.error.SKILL_FULL', 'skills.error.agentSkillsTooMany', 'skills.error.agentSkillsTooLarge', 'skills.error.tooLargeForAgent', 'skills.field.name.hint', 'skills.field.description.hint', 'skills.field.body.hint', 'skills.file.problem.too_large'] as const
    for (const key of keys) for (const text of [en[key], ko[key]]) expect(text).not.toMatch(/\b(24|8|6,?000|60|200|4000|64)\b/)
  })
})
