import { SKILL_MAX_ITEMS, normaliseSkillFields, skillProblemLine, type SkillFields, type SkillProblem } from '@rill/protocol'

export class SkillInvalidError extends Error {
  readonly problemList: SkillProblem[]
  readonly problems: string[]

  constructor(problems: SkillProblem[]) {
    super('the skill is not valid')
    this.name = 'SkillInvalidError'
    this.problemList = problems
    this.problems = problems.map(skillProblemLine)
  }
}

export class SkillFullError extends Error {
  constructor() {
    super(`at most ${SKILL_MAX_ITEMS} skills can be saved; delete one first`)
    this.name = 'SkillFullError'
  }
}

export class SkillDuplicateError extends Error {
  constructor() {
    super('a skill with the same name is already saved')
    this.name = 'SkillDuplicateError'
  }
}

export class SkillNotFoundError extends Error {
  constructor() {
    super('the skill was not found')
    this.name = 'SkillNotFoundError'
  }
}

export function normaliseSkill(input: SkillFields): SkillFields {
  const checked = normaliseSkillFields(input)
  if (!checked.ok) throw new SkillInvalidError(checked.problems)
  return checked.fields
}
