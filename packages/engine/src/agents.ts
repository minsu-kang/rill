import { AGENT_DEFAULT_ID, agentProblemLine, normaliseAgentFields, type Agent, type AgentFields, type AgentProblem } from '@rill/protocol'

export class AgentInvalidError extends Error {
  readonly problemList: AgentProblem[]
  readonly problems: string[]

  constructor(problems: AgentProblem[]) {
    super('the agent is not valid')
    this.name = 'AgentInvalidError'
    this.problemList = problems
    this.problems = problems.map(agentProblemLine)
  }
}

export class AgentFullError extends Error {
  constructor(limit: number) {
    super(`at most ${limit} agents can be saved; delete one first`)
    this.name = 'AgentFullError'
  }
}

export class AgentDuplicateError extends Error {
  constructor() {
    super('an agent with the same name is already saved')
    this.name = 'AgentDuplicateError'
  }
}

export class AgentNotFoundError extends Error {
  constructor() {
    super('the agent was not found')
    this.name = 'AgentNotFoundError'
  }
}

export class AgentBuiltinError extends Error {
  constructor() {
    super('the built-in agent cannot be changed or deleted')
    this.name = 'AgentBuiltinError'
  }
}

export function builtinAgent(): Agent {
  return { id: AGENT_DEFAULT_ID, name: 'Default', description: 'No persona and no instructions', persona: '', instructions: '', builtin: true, createdAt: 0, updatedAt: 0 }
}

export function normaliseAgent(input: AgentFields): AgentFields {
  const checked = normaliseAgentFields(input)
  if (!checked.ok) throw new AgentInvalidError(checked.problems)
  return checked.fields
}
