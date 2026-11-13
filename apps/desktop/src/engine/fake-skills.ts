import {
  AGENT_SKILLS_MAX_CHARS,
  SKILL_MAX_ITEMS,
  RillError,
  normaliseSkillFields,
  skillNameKey,
  skillProblemLine,
  type MethodParams,
  type MethodResult,
  type Skill,
} from '@rill/protocol'

export interface FakeSkillsOptions {
  skills?: readonly Skill[]
  now?: () => number
}

export interface FakeSkills {
  list(): MethodResult<'listSkills'>
  save(params: MethodParams<'saveSkill'>, agentSkillLists: ReadonlyArray<readonly string[]>): MethodResult<'saveSkill'>
  remove(params: MethodParams<'deleteSkill'>): MethodResult<'deleteSkill'>
  all(): readonly Skill[]
}

export function textLength(text: string): number {
  return [...text].length
}

function byName(a: Skill, b: Skill): number {
  const left = skillNameKey(a.name)
  const right = skillNameKey(b.name)
  return left < right ? -1 : left > right ? 1 : 0
}

export function createFakeSkills(options: FakeSkillsOptions = {}): FakeSkills {
  const saved: Skill[] = structuredClone([...(options.skills ?? [])])
  const now = options.now ?? Date.now
  let serial = 0

  const ordered = (): Skill[] => [...saved].sort(byName)

  function agentsBrokenBy(skillId: string, length: number, lists: ReadonlyArray<readonly string[]>): number {
    return lists.filter((ids) => {
      if (!ids.includes(skillId)) return false
      const total = ids.reduce((sum, id) => sum + (id === skillId ? length : textLength(saved.find((skill) => skill.id === id)?.body ?? '')), 0)
      return total > AGENT_SKILLS_MAX_CHARS
    }).length
  }

  return {
    list: () => ({ skills: structuredClone(ordered()) }),
    all: () => ordered(),
    save(params, lists) {
      const checked = normaliseSkillFields(params)
      if (!checked.ok) throw new RillError('SKILL_INVALID', 'the skill is not valid', checked.problems.map(skillProblemLine))
      const key = skillNameKey(checked.fields.name)
      const at = now()
      if (params.id !== undefined) {
        const found = saved.find((skill) => skill.id === params.id)
        if (found === undefined) throw new RillError('SKILL_NOT_FOUND', 'the skill was not found')
        if (saved.some((skill) => skill.id !== params.id && skillNameKey(skill.name) === key)) throw new RillError('SKILL_DUPLICATE', 'a skill with the same name is already saved')
        const broken = agentsBrokenBy(found.id, textLength(checked.fields.body), lists)
        if (broken > 0) throw new RillError('SKILL_INVALID', 'the skill is not valid', [skillProblemLine({ field: 'body', rule: 'too_large_for_agent', agents: broken })])
        Object.assign(found, checked.fields, { updatedAt: at })
        return { skill: structuredClone(found) }
      }
      if (saved.some((skill) => skillNameKey(skill.name) === key)) throw new RillError('SKILL_DUPLICATE', 'a skill with the same name is already saved')
      if (saved.length >= SKILL_MAX_ITEMS) throw new RillError('SKILL_FULL', `at most ${SKILL_MAX_ITEMS} skills can be saved; delete one first`)
      serial += 1
      const skill: Skill = { id: `skill-new-${serial}`, ...checked.fields, createdAt: at, updatedAt: at }
      saved.push(skill)
      return { skill: structuredClone(skill) }
    },
    remove({ id }) {
      const at = saved.findIndex((skill) => skill.id === id)
      if (at < 0) return { deleted: false }
      saved.splice(at, 1)
      return { deleted: true }
    },
  }
}
