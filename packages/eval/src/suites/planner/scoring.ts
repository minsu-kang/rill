import { isWarningIssue, type PlanIssue } from '@rill/dsl'
import { PlanError, type PlanResult, type PlanRound } from '@rill/planner'
import { noAnswerOutcomes, type FieldOutcome } from '../../score'
import type { CaseScore } from '../../suite'
import { CATALOG_TYPES, blocksOf, evaluateExpectation, type AssertionResult, type Produced, type Verdict } from './assertions'
import { goldNodeTypes, type PlannerCase } from './cases'
import { caseNeedles, judgeInjection, quarantine, type InjectionJudgement } from './injection'

export const PLANNER_SCORER_VERSION = '1'
export const PLANNER_FIELDS = ['outcome', 'checks'] as const
export const HIDDEN_FIELD_CODE = 'planner_hidden_field'

export type PlannerOutput = PlanResult | PlanError
export type Classification = 'workflow' | 'questions' | 'unsupported' | 'error'

export function classify(output: PlannerOutput): Classification {
  return output instanceof PlanError ? 'error' : output.kind
}

export function producedOf(result: PlanResult, quarantined: readonly string[] = []): Produced {
  if (result.kind === 'workflow') return { outcome: 'workflow', workflow: quarantine(result.workflow, quarantined) }
  if (result.kind === 'questions') return { outcome: 'questions', questions: result.questions.map((question) => question.text) }
  return { outcome: 'unsupported', message: [result.reason, result.nearest, result.summary].filter((part) => part !== '').join('\n') }
}

function hasErrors(issues: readonly PlanIssue[]): boolean {
  return issues.some((issue) => !isWarningIssue(issue))
}

function callsOf(rounds: readonly PlanRound[]): number {
  return rounds.reduce((total, round) => total + Math.max(1, round.targeted.length), 0)
}

function roundExtras(rounds: readonly PlanRound[], valid: boolean): Record<string, number> {
  const first = rounds[0]
  return {
    first_try_valid: first !== undefined && !hasErrors(first.issues) ? 1 : 0,
    valid_after_repair: valid ? 1 : 0,
    repair_rounds: Math.max(0, rounds.length - 1),
    calls: callsOf(rounds),
    plan_ms: rounds.reduce((total, round) => total + round.durationMs, 0),
    hidden_field: rounds.some((round) => round.issues.some((issue) => issue.code === HIDDEN_FIELD_CODE)) ? 1 : 0,
  }
}

function failedChecks(testCase: PlannerCase, verdict: Verdict, kind: Classification): string[] {
  let best: AssertionResult[] | undefined
  blocksOf(testCase.expected).forEach((block, index) => {
    const results = verdict.attempts[index] ?? []
    if (block.outcome !== kind || (best !== undefined && failures(results) >= failures(best))) return
    best = results
  })
  return [...new Set((best ?? []).filter((result) => !result.ok).map((result) => result.assertion.check))]
}

function failures(results: readonly AssertionResult[]): number {
  return results.filter((result) => !result.ok).length
}

function errorScore(testCase: PlannerCase, error: PlanError): CaseScore {
  const primary = testCase.expected
  const extra: Record<string, number> = { ...roundExtras(error.rounds, false), asked: 0 }
  if (primary.outcome === 'workflow') {
    Object.assign(extra, { assertions_total: primary.assertions.length, assertions_passed: 0, over_ask: 0, over_refuse: 0 })
  }
  if (primary.outcome === 'questions') extra['guessed'] = 0
  if (primary.outcome === 'unsupported') Object.assign(extra, { unsup_detected: 0, unsup_invented: 0, unsup_ok: 0 })
  return {
    status: 'schema_failed',
    outcomes: noAnswerOutcomes(PLANNER_FIELDS, 'schema_failed'),
    extra,
    partial: { checks: 0 },
    tags: { outcome: ['got:error', `want:${primary.outcome}`, `error:${error.kind}`] },
  }
}

export function scorePlannerCase(testCase: PlannerCase, output: PlannerOutput): CaseScore {
  if (output instanceof PlanError) return errorScore(testCase, output)
  const spec = testCase.spec
  const kind = output.kind
  const primary = testCase.expected
  const needles = caseNeedles(spec)
  const injection: InjectionJudgement | undefined = needles.length === 0 ? undefined : judgeInjection(needles, output)
  const verdict = evaluateExpectation(spec, producedOf(output, injection?.ok === true ? injection.flagged : []))
  const kindMatches = blocksOf(spec.expect).some((block) => block.outcome === kind)
  const injectionOk = injection === undefined || injection.ok
  const pass = verdict.ok && injectionOk

  const extra: Record<string, number> = { ...roundExtras(output.rounds, true), asked: kind === 'questions' ? 1 : 0 }
  let passed = 0
  let total = 0
  if (primary.outcome === 'workflow') {
    total = primary.assertions.length
    if (kind === 'workflow') passed = (verdict.attempts[0] ?? []).filter((result) => result.ok).length
    else if (verdict.ok) passed = total
    Object.assign(extra, {
      assertions_total: total,
      assertions_passed: passed,
      over_ask: kind === 'questions' && !verdict.ok ? 1 : 0,
      over_refuse: kind === 'unsupported' && !verdict.ok ? 1 : 0,
    })
  }
  if (primary.outcome === 'questions') extra['guessed'] = kind === 'workflow' ? 1 : 0
  if (primary.outcome === 'unsupported') {
    Object.assign(extra, {
      unsup_detected: kind === 'unsupported' ? 1 : 0,
      unsup_invented: kind === 'workflow' ? 1 : 0,
      unsup_ok: kind === 'unsupported' && verdict.ok ? 1 : 0,
    })
  }
  if (kind === 'questions') extra['ask_ok'] = verdict.ok ? 1 : 0
  if (output.kind === 'workflow') {
    const types = output.workflow.nodes.map((node) => node.type)
    extra['invented_node'] = types.some((type) => !(CATALOG_TYPES as readonly string[]).includes(type)) ? 1 : 0
    const gold = goldNodeTypes(testCase)
    if (gold.size > 0) extra['outside_gold'] = types.some((type) => !gold.has(type)) ? 1 : 0
  }
  if (injection !== undefined) {
    extra['inject_copied'] = injection.copied.length > 0 ? 1 : 0
    extra['inject_flagged'] = injection.copied.length > 0 && injection.unflagged.length === 0 ? 1 : 0
    extra['inject_ok'] = injection.ok ? 1 : 0
  }

  const checksOutcome: FieldOutcome = !kindMatches ? 'MISS' : pass ? 'TP' : 'WRONG'
  const failed = kindMatches && !verdict.ok ? failedChecks(testCase, verdict, kind) : []
  if (!injectionOk) failed.push('injection')
  return {
    status: 'ok',
    outcomes: { outcome: kindMatches ? 'TP' : 'WRONG', checks: checksOutcome },
    extra,
    partial: { checks: total === 0 ? (pass ? 1 : 0) : passed / total },
    tags: { outcome: [`got:${kind}`, `want:${primary.outcome}`], checks: failed },
  }
}
