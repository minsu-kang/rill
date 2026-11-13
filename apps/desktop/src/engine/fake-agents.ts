import {
  AGENT_DEFAULT_ID,
  AGENT_MAX_ITEMS,
  AGENT_SKILLS_MAX_CHARS,
  RillError,
  agentNameKey,
  agentProblemLine,
  agentSkillProblemLine,
  checkAgentSkillIds,
  isReservedAgentName,
  normaliseAgentFields,
  type Agent,
  type AgentSkillRule,
  type MethodParams,
  type MethodResult,
  type Skill,
} from '@rill/protocol'
import { textLength } from './fake-skills'

export interface FakeAgentsOptions {
  agents?: readonly Agent[]
  activeId?: string
  skills?: () => readonly Skill[]
  now?: () => number
}

export interface FakeAgents {
  list(): MethodResult<'listAgents'>
  save(params: MethodParams<'saveAgent'>): MethodResult<'saveAgent'>
  remove(params: MethodParams<'deleteAgent'>): MethodResult<'deleteAgent'>
  setActive(params: MethodParams<'setActiveAgent'>): MethodResult<'setActiveAgent'>
  resolve(agentId: string | undefined): Agent | undefined
  resolveReviewer(agentId: string): Agent
  skillLists(): string[][]
  dropSkill(skillId: string): void
}

export function builtinAgent(): Agent {
  return { id: AGENT_DEFAULT_ID, name: 'Default', description: 'No persona and no instructions', persona: '', instructions: '', kind: 'assistant', skillIds: [], builtin: true, createdAt: 0, updatedAt: 0 }
}

function filled(agent: Agent): Agent {
  return { ...structuredClone(agent), kind: agent.kind ?? 'assistant', skillIds: [...(agent.skillIds ?? [])] }
}

export function createFakeAgents(options: FakeAgentsOptions = {}): FakeAgents {
  const saved: Agent[] = (options.agents ?? []).map(filled)
  let activeId = options.activeId ?? AGENT_DEFAULT_ID
  const now = options.now ?? Date.now
  let serial = 0

  const ordered = (): Agent[] => [...saved].sort((a, b) => (agentNameKey(a.name) < agentNameKey(b.name) ? -1 : agentNameKey(a.name) > agentNameKey(b.name) ? 1 : 0))
  const skills = options.skills ?? ((): readonly Skill[] => [])
  const active = (): string => (activeId === AGENT_DEFAULT_ID || saved.some((agent) => agent.id === activeId) ? activeId : AGENT_DEFAULT_ID)

  return {
    list: () => ({ agents: structuredClone([builtinAgent(), ...ordered()]), activeId: active() }),
    save(params) {
      if (params.id === AGENT_DEFAULT_ID) throw new RillError('AGENT_BUILTIN', 'the built-in agent cannot be changed or deleted')
      const checked = normaliseAgentFields(params)
      const listProblems = params.skillIds === undefined ? [] : checkAgentSkillIds(params.skillIds)
      if (!checked.ok || listProblems.length > 0) {
        throw new RillError('AGENT_INVALID', 'the agent is not valid', [...(checked.ok ? [] : checked.problems.map(agentProblemLine)), ...listProblems.map(agentSkillProblemLine)])
      }
      if (isReservedAgentName(checked.fields.name)) throw new RillError('AGENT_DUPLICATE', 'an agent with the same name is already saved')
      const key = agentNameKey(checked.fields.name)
      const at = now()
      if (params.skillIds !== undefined) {
        const problem = skillListProblem(params.skillIds, skills())
        if (problem !== undefined) throw new RillError('AGENT_INVALID', 'the agent is not valid', [agentSkillProblemLine(problem)])
      }
      if (params.id !== undefined) {
        const found = saved.find((agent) => agent.id === params.id)
        if (found === undefined) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
        if (params.kind === 'reviewer' && active() === found.id) throw new RillError('AGENT_NOT_ASSISTANT', 'only an assistant agent can be the active agent or be used to plan or explain')
        if (saved.some((agent) => agent.id !== params.id && agentNameKey(agent.name) === key)) throw new RillError('AGENT_DUPLICATE', 'an agent with the same name is already saved')
        Object.assign(found, checked.fields, {
          kind: params.kind ?? found.kind,
          skillIds: params.skillIds === undefined ? found.skillIds : [...params.skillIds],
          updatedAt: at,
        })
        return { agent: structuredClone(found) }
      }
      if (saved.some((agent) => agentNameKey(agent.name) === key)) throw new RillError('AGENT_DUPLICATE', 'an agent with the same name is already saved')
      if (saved.length >= AGENT_MAX_ITEMS) throw new RillError('AGENT_FULL', `at most ${AGENT_MAX_ITEMS} agents can be saved; delete one first`)
      serial += 1
      const agent: Agent = {
        id: `agent-new-${serial}`,
        ...checked.fields,
        kind: params.kind ?? 'assistant',
        skillIds: [...(params.skillIds ?? [])],
        builtin: false,
        createdAt: at,
        updatedAt: at,
      }
      saved.push(agent)
      return { agent: structuredClone(agent) }
    },
    remove({ id }) {
      if (id === AGENT_DEFAULT_ID) throw new RillError('AGENT_BUILTIN', 'the built-in agent cannot be changed or deleted')
      const at = saved.findIndex((agent) => agent.id === id)
      if (at < 0) return { deleted: false }
      saved.splice(at, 1)
      if (activeId === id) activeId = AGENT_DEFAULT_ID
      return { deleted: true }
    },
    setActive({ id }) {
      const found = saved.find((agent) => agent.id === id)
      if (id !== AGENT_DEFAULT_ID && found === undefined) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
      if (found?.kind === 'reviewer') throw new RillError('AGENT_NOT_ASSISTANT', 'only an assistant agent can be the active agent or be used to plan or explain')
      activeId = id
      return {}
    },
    resolve(agentId) {
      if (agentId === undefined || agentId === AGENT_DEFAULT_ID) return undefined
      const found = saved.find((agent) => agent.id === agentId)
      if (found === undefined) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
      if (found.kind === 'reviewer') throw new RillError('AGENT_NOT_ASSISTANT', 'only an assistant agent can be the active agent or be used to plan or explain')
      return structuredClone(found)
    },
    resolveReviewer(agentId) {
      if (agentId === AGENT_DEFAULT_ID) throw new RillError('AGENT_NOT_REVIEWER', 'only a reviewer agent can review a plan')
      const found = saved.find((agent) => agent.id === agentId)
      if (found === undefined) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
      if (found.kind !== 'reviewer') throw new RillError('AGENT_NOT_REVIEWER', 'only a reviewer agent can review a plan')
      return structuredClone(found)
    },
    skillLists: () => saved.map((agent) => [...(agent.skillIds ?? [])]),
    dropSkill(skillId) {
      for (const agent of saved) agent.skillIds = (agent.skillIds ?? []).filter((id) => id !== skillId)
    },
  }
}

function skillListProblem(ids: readonly string[], skills: readonly Skill[]): AgentSkillRule | undefined {
  const known = new Map(skills.map((skill) => [skill.id, skill]))
  const unique = [...new Set(ids)]
  if (unique.some((id) => !known.has(id))) return 'unknown'
  return unique.reduce((total, id) => total + textLength(known.get(id)!.body), 0) > AGENT_SKILLS_MAX_CHARS ? 'too_large' : undefined
}
