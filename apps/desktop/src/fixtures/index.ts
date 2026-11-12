import type { NodeInfo } from '@rill/protocol'
import type { FakeData } from '../engine/fake-client'
import catalogJson from './catalog.json'
import { fixtureRuns, fixtureSteps, FIXTURE_NOW, ids } from './runs'
import { workflows } from './workflows'

export * from './workflows'
export * from './hostile'
export { fixtureRuns, fixtureSteps, FIXTURE_NOW, ids }

export const catalog = catalogJson as NodeInfo[]

export const fakeData: FakeData = {
  workflows: [
    { id: ids.workflows.receipt, workflow: workflows.receipt, active: true, createdAt: FIXTURE_NOW - 30 * 24 * 3_600_000 },
    { id: ids.workflows.branching, workflow: workflows.branching, active: true, createdAt: FIXTURE_NOW - 20 * 24 * 3_600_000 },
    { id: ids.workflows.webhook, workflow: workflows.webhook, active: false, createdAt: FIXTURE_NOW - 10 * 24 * 3_600_000 },
  ],
  runs: fixtureRuns,
  steps: fixtureSteps,
  catalog,
}
