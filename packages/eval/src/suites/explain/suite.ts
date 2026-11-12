import { createHash } from 'node:crypto'
import { createCoreRegistry, type NodeRegistry } from '@rill/nodes-core'
import { EXPLAIN_BUDGETS, EXPLAIN_RULES, ExplainError, createExplainer, explainSchema } from '@rill/planner'
import { estimateCallUsd } from '../../pricing'
import { PRICE_TABLE_AS_OF } from '../../pricing'
import { softCapFactor } from '../../spec'
import type { Suite } from '../../suite'
import { TEXT_CHARS_PER_TOKEN } from '../extract/suite'
import { digestOf, explainInputOf, toExplainCase, type ExplainCase } from './cases'
import type { ExplainFactory } from './fakes'
import type { ExplainDraftFile } from './schema'
import { EXPLAIN_FIELDS, EXPLAIN_SCORER_VERSION, scoreExplainCase, type ExplainOutput } from './scoring'

export type { ExplainFactory, ExplainFactoryInput } from './fakes'

export const EXPLAIN_SUITE_NAME = 'explain'
export const EXPLAIN_SUITE_NUMBER = 1

const INPUT_MARGIN = 1.15
const REPAIR_TOKENS = 300
const CALLS = 2
const VERSION_HASH_LENGTH = 12

export interface ExplainSuiteOptions {
  data: ExplainDraftFile
  makeExplainer?: ExplainFactory
  registry?: NodeRegistry
}

export type ExplainSuite = Suite<ExplainCase, ExplainOutput>

function serializable(error: ExplainError): ExplainError {
  Object.defineProperty(error, 'toJSON', { value: () => ({ name: error.name, kind: error.kind, message: error.message }), enumerable: false, configurable: true })
  return error
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, VERSION_HASH_LENGTH)
}

export function createExplainSuite(options: ExplainSuiteOptions): ExplainSuite {
  if (options?.data === undefined) throw new TypeError('createExplainSuite needs the draft data handed over')
  const registry = options.registry ?? createCoreRegistry()
  const makeExplainer: ExplainFactory = options.makeExplainer ?? (({ ctx }) => createExplainer({ provider: ctx.provider, registry }))
  const cases = options.data.cases.map(toExplainCase)
  const baseChars = EXPLAIN_RULES.length + JSON.stringify(explainSchema()).length
  const inputTokens = (testCase: ExplainCase): number =>
    Math.ceil(((baseChars + digestOf(testCase.spec, registry).chars) / TEXT_CHARS_PER_TOKEN) * INPUT_MARGIN)
  return {
    name: EXPLAIN_SUITE_NAME,
    version: [`${EXPLAIN_SUITE_NUMBER}.${EXPLAIN_SCORER_VERSION}`, `p${PRICE_TABLE_AS_OF.replace(/-/gu, '')}`, sha256(JSON.stringify(options.data.cases))].join('-'),
    fields: EXPLAIN_FIELDS,
    cases: () => cases,
    run: async (testCase, ctx) => {
      const explainer = makeExplainer({ testCase, ctx, registry })
      try {
        return await explainer.explain({ ...explainInputOf(testCase.spec, registry), effort: testCase.spec.effort, signal: ctx.signal })
      } catch (error) {
        if (!(error instanceof ExplainError) || error.kind !== 'invalid') throw error
        return serializable(error)
      }
    },
    score: (testCase, output) => scoreExplainCase(testCase, output, registry),
    estimateInputTokens: inputTokens,
    worstCaseUsd: (testCase, model, maxOutputTokens) => {
      const output = Math.min(maxOutputTokens, EXPLAIN_BUDGETS[testCase.spec.effort].maxTokens) * softCapFactor(model)
      const first = estimateCallUsd(model, inputTokens(testCase), output)
      const repair = estimateCallUsd(model, inputTokens(testCase) + REPAIR_TOKENS, output)
      return first === undefined || repair === undefined ? undefined : first + repair * (CALLS - 1)
    },
  }
}
