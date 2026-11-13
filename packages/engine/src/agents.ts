import {
  AGENT_DEFAULT_ID,
  agentProblemLine,
  agentSkillProblemLine,
  checkAgentSkillIds,
  normaliseAgentFields,
  type Agent,
  type AgentFields,
  type AgentProblem,
  type AgentSkillRule,
} from '@rill/protocol'

export class AgentInvalidError extends Error {
  readonly problemList: AgentProblem[]
  readonly skillProblemList: AgentSkillRule[]
  readonly problems: string[]

  constructor(problems: AgentProblem[], skillProblems: AgentSkillRule[] = []) {
    super('the agent is not valid')
    this.name = 'AgentInvalidError'
    this.problemList = problems
    this.skillProblemList = skillProblems
    this.problems = [...problems.map(agentProblemLine), ...skillProblems.map(agentSkillProblemLine)]
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

export class AgentNotAssistantError extends Error {
  constructor() {
    super('only an assistant agent can be the active agent or be used to plan or explain')
    this.name = 'AgentNotAssistantError'
  }
}

export class AgentNotReviewerError extends Error {
  constructor() {
    super('only a reviewer agent can review a plan')
    this.name = 'AgentNotReviewerError'
  }
}

export function builtinAgent(): Agent {
  return {
    id: AGENT_DEFAULT_ID,
    name: 'Default',
    description: 'No persona and no instructions',
    persona: '',
    instructions: '',
    kind: 'assistant',
    skillIds: [],
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

export function normaliseAgent(input: AgentFields & { skillIds?: readonly string[] }): AgentFields {
  const checked = normaliseAgentFields(input)
  const skillProblems = input.skillIds === undefined ? [] : checkAgentSkillIds(input.skillIds)
  if (!checked.ok || skillProblems.length > 0) throw new AgentInvalidError(checked.ok ? [] : checked.problems, skillProblems)
  return checked.fields
}
