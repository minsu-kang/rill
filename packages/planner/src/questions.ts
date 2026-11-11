import type { PlanIssue, Workflow } from '@rill/dsl'
import type { PlanContext, PlanQuestion, PlanTurn } from './types'

export const MAX_QUESTIONS = 3
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4
export const MAX_QUESTION_TURNS = 2

export const NOTICE_CODES: readonly string[] = ['questions_truncated', 'question_options_truncated', 'question_default_replaced']

export function isNoticeIssue(issue: PlanIssue): boolean {
  return NOTICE_CODES.includes(issue.code)
}

function notice(pointer: string, code: string, message: string): PlanIssue {
  return { stage: 4, pointer, code, message }
}

export function normalizeQuestions(input: readonly PlanQuestion[]): { questions: PlanQuestion[]; issues: PlanIssue[] } {
  const issues: PlanIssue[] = []
  if (input.length === 0) {
    return { questions: [], issues: [{ stage: 4, pointer: '/questions', code: 'questions_empty', message: 'kind is questions but no question was given' }] }
  }
  if (input.length > MAX_QUESTIONS) {
    issues.push(notice(`/questions/${MAX_QUESTIONS}`, 'questions_truncated', `only the first ${MAX_QUESTIONS} of ${input.length} questions were kept`))
  }
  const seen = new Set<string>()
  const questions: PlanQuestion[] = []
  input.slice(0, MAX_QUESTIONS).forEach((question, index) => {
    const base = `/questions/${index}`
    if (seen.has(question.id)) {
      issues.push({ stage: 4, pointer: `${base}/id`, code: 'question_duplicate_id', message: `question id ${question.id} is used twice` })
      return
    }
    seen.add(question.id)
    const unique = [...new Set(question.options.map((option) => option.trim()).filter((option) => option !== ''))]
    if (unique.length < MIN_OPTIONS) {
      issues.push({ stage: 4, pointer: `${base}/options`, code: 'question_options', message: `question ${question.id} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} different options`, hint: 'offer the safe default and at least one alternative' })
      return
    }
    if (unique.length > MAX_OPTIONS) {
      issues.push(notice(`${base}/options/${MAX_OPTIONS}`, 'question_options_truncated', `question ${question.id}: only the first ${MAX_OPTIONS} options were kept`))
    }
    const options = unique.slice(0, MAX_OPTIONS)
    const trimmed = question.default.trim()
    const fallback = options.includes(trimmed) ? trimmed : options[0]!
    if (fallback !== trimmed) {
      issues.push(notice(`${base}/default`, 'question_default_replaced', `question ${question.id}: the default was not one of the options, so the first option is the default`))
    }
    questions.push({ id: question.id, text: question.text, options, default: fallback })
  })
  return { questions, issues }
}

export function questionTurnsSinceLastWorkflow(turns: readonly PlanTurn[]): number {
  let count = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (turn.role !== 'assistant') continue
    if (turn.result?.kind === 'workflow') break
    if (turn.result?.kind === 'questions') count++
  }
  return count
}

export function isGapIssue(issue: PlanIssue, context: PlanContext): boolean {
  if (issue.code === 'unknown_connection') return context.connections.length === 0
  if (issue.code === 'path_outside_roots') return context.allowedRoots.length === 0
  return false
}

function nodeIdsOf(issues: readonly PlanIssue[], workflow: Workflow | undefined): string[] {
  const ids = issues.map((issue) => {
    const match = /^\/nodes\/(\d+)\//.exec(issue.pointer)
    return match ? workflow?.nodes[Number(match[1])]?.id : undefined
  })
  return [...new Set(ids.filter((id): id is string => id !== undefined))].sort()
}

export function gapQuestions(gaps: readonly PlanIssue[], workflow: Workflow | undefined): { questions: PlanQuestion[]; summary: string } {
  const questions: PlanQuestion[] = []
  const connection = gaps.filter((issue) => issue.code === 'unknown_connection')
  if (connection.length > 0) {
    const ids = nodeIdsOf(connection, workflow)
    const where = ids.length > 0 ? ` (needed by ${ids.join(', ')})` : ''
    questions.push({
      id: 'setup_connection',
      text: `This workflow needs a connection${where}, but no connection is set up yet. Set one up in Settings first, or write the result to a CSV file instead?`,
      options: ['Set up a connection first', 'Write to a CSV file instead'],
      default: 'Set up a connection first',
    })
  }
  const folder = gaps.filter((issue) => issue.code === 'path_outside_roots')
  if (folder.length > 0) {
    const ids = nodeIdsOf(folder, workflow)
    const where = ids.length > 0 ? ` (needed by ${ids.join(', ')})` : ''
    questions.push({
      id: 'allow_folder',
      text: `This workflow uses a folder${where}, but no folder is allowed yet. Add the folder to the allowed folders in Settings first?`,
      options: ['Add the folder first', 'Cancel'],
      default: 'Add the folder first',
    })
  }
  return { questions, summary: 'Before I can plan this, something has to be set up first.' }
}
