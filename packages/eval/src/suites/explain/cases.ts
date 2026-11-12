import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { NodeRegistry } from '@rill/nodes-core'
import { buildRunDigest, type ExplainRunInput, type ExplainStep, type RunDigest } from '@rill/planner'
import type { EvalCase } from '../../suite'
import { parseExplainDraft, type ExplainCaseSpec, type ExplainDraftFile } from './schema'

export const EXPLAIN_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))
export const EXPLAIN_DRAFT_PATH = `${EXPLAIN_DATA_DIR}cases.draft.json`
export const EXPLAIN_GROUP = 'explain'

export interface ExplainCase extends EvalCase {
  spec: ExplainCaseSpec
}

export function loadExplainDraft(): ExplainDraftFile {
  return parseExplainDraft(JSON.parse(readFileSync(EXPLAIN_DRAFT_PATH, 'utf8')))
}

export function toExplainCase(spec: ExplainCaseSpec): ExplainCase {
  const injection = spec.expect.injection !== undefined
  return {
    id: spec.id,
    group: EXPLAIN_GROUP,
    category: injection ? 'injection' : 'failure',
    tags: [...(spec.tags ?? []), ...spec.expect.signals.map((entry) => entry.signal)],
    kind: spec.expect.likelyCause[0] ?? 'unknown',
    spec,
  }
}

export function explainInputOf(spec: ExplainCaseSpec, registry: NodeRegistry): ExplainRunInput {
  const steps: ExplainStep[] = spec.steps.map((step) => ({ ...step }))
  return {
    run: { id: `run-${spec.id}`, ...spec.run },
    steps,
    workflow: spec.workflow,
    registry,
    secrets: spec.secrets,
  }
}

export function digestOf(spec: ExplainCaseSpec, registry: NodeRegistry): RunDigest {
  return buildRunDigest(explainInputOf(spec, registry))
}
