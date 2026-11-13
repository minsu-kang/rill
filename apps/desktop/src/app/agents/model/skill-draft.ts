import { SKILL_FIELDS, SKILL_FIELD_LIMITS, normaliseTextField, type AgentRule, type Skill, type SkillField, type SkillFields } from '@rill/protocol'

export type SkillDraft = SkillFields
export type SkillDraftProblems = Partial<Record<SkillField, AgentRule>>

export function emptySkillDraft(): SkillDraft {
  return { name: '', description: '', body: '' }
}

export function skillDraftOf(skill: Pick<Skill, SkillField>): SkillDraft {
  return { name: skill.name, description: skill.description, body: skill.body }
}

export function sameSkillDraft(a: SkillDraft, b: SkillDraft): boolean {
  return SKILL_FIELDS.every((field) => a[field] === b[field])
}

export function skillDraftProblems(draft: SkillDraft): SkillDraftProblems {
  const problems: SkillDraftProblems = {}
  for (const field of SKILL_FIELDS) {
    const checked = normaliseTextField(field, draft[field], SKILL_FIELD_LIMITS[field])
    if (!checked.ok) problems[field] = checked.rule
  }
  return problems
}

export function skillCountOf(field: SkillField, raw: string): number {
  const checked = normaliseTextField(field, raw, SKILL_FIELD_LIMITS[field])
  return [...(checked.ok ? checked.value : raw.normalize('NFC').trim())].length
}

export function hasSkillProblems(problems: SkillDraftProblems): boolean {
  return Object.keys(problems).length > 0
}
