import type { agentsKo } from './agents.ko'

export const agentsEn: Record<keyof typeof agentsKo, string> = {
  'agents.default.name': 'Default',
  'agents.default.description': 'The built-in setup with no persona and no instructions.',
  'agents.picker.label': 'Agent',
  'agents.picker.loading': 'Loading agents…',
  'agents.picker.loadError': 'Could not load the agents.',
  'agents.picker.changeError': 'Could not change the agent.',
}
