import {
  AGENT_DEFAULT_ID,
  AGENT_MAX_ITEMS,
  RillError,
  agentNameKey,
  agentProblemLine,
  normaliseAgentFields,
  type Agent,
  type MethodParams,
  type MethodResult,
} from '@rill/protocol'

export interface FakeAgentsOptions {
  agents?: readonly Agent[]
  activeId?: string
  now?: () => number
}

export interface FakeAgents {
  list(): MethodResult<'listAgents'>
  save(params: MethodParams<'saveAgent'>): MethodResult<'saveAgent'>
  remove(params: MethodParams<'deleteAgent'>): MethodResult<'deleteAgent'>
  setActive(params: MethodParams<'setActiveAgent'>): MethodResult<'setActiveAgent'>
  resolve(agentId: string | undefined): Agent | undefined
}

export function builtinAgent(): Agent {
  return { id: AGENT_DEFAULT_ID, name: 'Default', description: 'No persona and no instructions', persona: '', instructions: '', builtin: true, createdAt: 0, updatedAt: 0 }
}

export function createFakeAgents(options: FakeAgentsOptions = {}): FakeAgents {
  const saved: Agent[] = structuredClone([...(options.agents ?? [])])
  let activeId = options.activeId ?? AGENT_DEFAULT_ID
  const now = options.now ?? Date.now
  let serial = 0

  const ordered = (): Agent[] => [...saved].sort((a, b) => (agentNameKey(a.name) < agentNameKey(b.name) ? -1 : agentNameKey(a.name) > agentNameKey(b.name) ? 1 : 0))
  const active = (): string => (activeId === AGENT_DEFAULT_ID || saved.some((agent) => agent.id === activeId) ? activeId : AGENT_DEFAULT_ID)

  return {
    list: () => ({ agents: structuredClone([builtinAgent(), ...ordered()]), activeId: active() }),
    save(params) {
      if (params.id === AGENT_DEFAULT_ID) throw new RillError('AGENT_BUILTIN', 'the built-in agent cannot be changed or deleted')
      const checked = normaliseAgentFields(params)
      if (!checked.ok) throw new RillError('AGENT_INVALID', 'the agent is not valid', checked.problems.map(agentProblemLine))
      const key = agentNameKey(checked.fields.name)
      const at = now()
      if (params.id !== undefined) {
        const found = saved.find((agent) => agent.id === params.id)
        if (found === undefined) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
        if (saved.some((agent) => agent.id !== params.id && agentNameKey(agent.name) === key)) throw new RillError('AGENT_DUPLICATE', 'an agent with the same name is already saved')
        Object.assign(found, checked.fields, { updatedAt: at })
        return { agent: structuredClone(found) }
      }
      if (saved.some((agent) => agentNameKey(agent.name) === key)) throw new RillError('AGENT_DUPLICATE', 'an agent with the same name is already saved')
      if (saved.length >= AGENT_MAX_ITEMS) throw new RillError('AGENT_FULL', `at most ${AGENT_MAX_ITEMS} agents can be saved; delete one first`)
      serial += 1
      const agent: Agent = { id: `agent-new-${serial}`, ...checked.fields, builtin: false, createdAt: at, updatedAt: at }
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
      if (id !== AGENT_DEFAULT_ID && !saved.some((agent) => agent.id === id)) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
      activeId = id
      return {}
    },
    resolve(agentId) {
      if (agentId === undefined || agentId === AGENT_DEFAULT_ID) return undefined
      const found = saved.find((agent) => agent.id === agentId)
      if (found === undefined) throw new RillError('AGENT_NOT_FOUND', 'the agent was not found')
      return structuredClone(found)
    },
  }
}
