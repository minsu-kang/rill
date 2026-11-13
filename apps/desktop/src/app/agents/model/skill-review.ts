import { normaliseTextField, skillNameKey, SKILL_FIELD_LIMITS, type Skill, type SkillFields } from '@rill/protocol'
import type { SkillFileProblem } from '../skill-file'
import { hasSkillProblems, skillDraftProblems, type SkillDraftProblems } from './skill-draft'
import type { SkillReviewState } from './skill-view'

export interface SkillReviewOutcome {
  fields: SkillFields | undefined
  fileProblems: SkillFileProblem[]
  fieldProblems: SkillDraftProblems
  duplicate: boolean
  canSave: boolean
}

export function skillReviewOutcome(review: SkillReviewState, skills: readonly Skill[]): SkillReviewOutcome {
  if (review.base === undefined) return { fields: undefined, fileProblems: review.fileProblems, fieldProblems: {}, duplicate: false, canSave: false }
  const fields: SkillFields = { ...review.base, name: review.name, description: review.description }
  const fieldProblems = skillDraftProblems(fields)
  const named = normaliseTextField('name', fields.name, SKILL_FIELD_LIMITS.name)
  const duplicate = named.ok && skills.some((skill) => skillNameKey(skill.name) === skillNameKey(named.value))
  return { fields, fileProblems: review.fileProblems, fieldProblems, duplicate, canSave: review.fileProblems.length === 0 && !hasSkillProblems(fieldProblems) && !duplicate }
}
