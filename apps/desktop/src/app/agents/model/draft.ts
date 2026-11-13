import { AGENT_FIELDS, AGENT_DEFAULT_ID, normaliseAgentField, type Agent, type AgentField, type AgentFields, type AgentRule } from '@rill/protocol'

export type AgentDraft = AgentFields
export type DraftProblems = Partial<Record<AgentField, AgentRule>>

export function emptyDraft(): AgentDraft {
  return { name: '', description: '', persona: '', instructions: '' }
}

export function draftOf(agent: Pick<Agent, AgentField>): AgentDraft {
  return { name: agent.name, description: agent.description, persona: agent.persona, instructions: agent.instructions }
}

export function sameDraft(a: AgentDraft, b: AgentDraft): boolean {
  return AGENT_FIELDS.every((field) => a[field] === b[field])
}

export function draftProblems(draft: AgentDraft): DraftProblems {
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
