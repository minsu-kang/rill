import type { Planner, PlannerDeps } from './ports'

export function createPlanner(deps: PlannerDeps): Planner {
  void deps
  throw new Error('createPlanner is not implemented yet')
}
