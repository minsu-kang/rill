import { AGENT_FIELDS, AGENT_DEFAULT_ID, AGENT_MAX_SKILLS, AGENT_SKILLS_MAX_CHARS, normaliseAgentField, type Agent, type AgentField, type AgentFields, type AgentKind, type AgentRule, type AgentSkillRule, type Skill } from '@rill/protocol'
import { kindOf, skillIdsOf, type AgentInput } from '../../../engine/agents'

export type AgentDraft = AgentFields & { kind: AgentKind; skillIds: readonly string[] }
export type DraftProblems = Partial<Record<AgentField, AgentRule>>

export function emptyDraft(): AgentDraft {
  return { name: '', description: '', persona: '', instructions: '', kind: 'assistant', skillIds: [] }
}

export function draftOf(agent: Pick<Agent, AgentField | 'kind' | 'skillIds'>): AgentDraft {
  return { name: agent.name, description: agent.description, persona: agent.persona, instructions: agent.instructions, kind: kindOf(agent), skillIds: [...skillIdsOf(agent)] }
}

export function sameSkillIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

export function sameDraft(a: AgentDraft, b: AgentDraft): boolean {
  return AGENT_FIELDS.every((field) => a[field] === b[field]) && a.kind === b.kind && sameSkillIds(a.skillIds, b.skillIds)
}

export function draftProblems(draft: AgentFields): DraftProblems {
  const problems: DraftProblems = {}
  for (const field of AGENT_FIELDS) {
    const checked = normaliseAgentField(field, draft[field])
    if (!checked.ok) problems[field] = checked.rule
  }
  return problems
}

export function countOf(field: AgentField, raw: string): number {
  const checked = normaliseAgentField(field, raw)
  return [...(checked.ok ? checked.value : raw.normalize('NFC').trim())].length
}

export function hasProblems(problems: DraftProblems): boolean {
  return Object.keys(problems).length > 0
}

export function isBuiltin(agent: Pick<Agent, 'id'>): boolean {
  return agent.id === AGENT_DEFAULT_ID
}

export interface SkillBudget {
  count: number
  chars: number
  unknown: number
}

export function skillBudget(skillIds: readonly string[], skills: readonly Skill[]): SkillBudget {
  const known = skillIds.flatMap((id) => skills.filter((skill) => skill.id === id))
  return { count: known.length, chars: known.reduce((sum, skill) => sum + [...skill.body].length, 0), unknown: skillIds.length - known.length }
}

export function withKnownSkills(draft: AgentDraft, skills: readonly Skill[] | undefined): AgentDraft {
  if (skills === undefined) return draft
  const skillIds = draft.skillIds.filter((id) => skills.some((skill) => skill.id === id))
  return skillIds.length === draft.skillIds.length ? draft : { ...draft, skillIds }
}

export function skillsProblem(skillIds: readonly string[], skills: readonly Skill[]): AgentSkillRule | undefined {
  const budget = skillBudget(skillIds, skills)
  if (budget.unknown > 0) return 'unknown'
  if (budget.count > AGENT_MAX_SKILLS) return 'too_many'
  return budget.chars > AGENT_SKILLS_MAX_CHARS ? 'too_large' : undefined
}

export function saveInput(draft: AgentDraft, baseline: AgentDraft, id: string | undefined): AgentInput {
  return {
    ...(id === undefined ? {} : { id }),
    name: draft.name,
    description: draft.description,
    persona: draft.persona,
    instructions: draft.instructions,
    ...(draft.kind === baseline.kind ? {} : { kind: draft.kind }),
    ...(sameSkillIds(draft.skillIds, baseline.skillIds) ? {} : { skillIds: [...draft.skillIds] }),
  }
}
