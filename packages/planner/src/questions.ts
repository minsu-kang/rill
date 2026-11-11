import type { PlanIssue, Workflow } from '@rill/dsl'
import { CONNECTION_KIND_CODE, connectionSiteAt, type ConnectionKind } from './connections'
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

const CONNECTION_GAP_CODES: readonly string[] = ['unknown_connection', CONNECTION_KIND_CODE]

export function isGapIssue(issue: PlanIssue, context: PlanContext, workflow?: Workflow): boolean {
  if (CONNECTION_GAP_CODES.includes(issue.code)) {
    const needed = connectionSiteAt(issue.pointer, workflow)?.kind
    if (needed === undefined) return issue.code === 'unknown_connection' && context.connections.length === 0
    return !context.connections.some((connection) => connection.kind === needed)
  }
  if (issue.code === 'path_outside_roots') return context.allowedRoots.length === 0
  return false
}

export type GapLanguage = 'en' | 'ko'

export function gapLanguage(text: string): GapLanguage {
  return /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/.test(text) ? 'ko' : 'en'
}

const KIND_LABELS: Record<GapLanguage, Record<ConnectionKind, string>> = {
  en: { slack: 'Slack', http: 'HTTP', webhookSecret: 'webhook secret' },
  ko: { slack: 'Slack', http: 'HTTP', webhookSecret: '웹훅 시크릿' },
}

interface GapText {
  connectionQuestion(kinds: string, where: string, csv: boolean): string
  connectionSetup: string
  connectionCsv: string
  folderQuestion(where: string): string
  folderAdd: string
  cancel: string
  summary: string
  missingConnection(kinds: string, where: string): string
  missingFolder(where: string): string
  planned(missing: string): string
  where(ids: readonly string[]): string
}

const GAP_TEXT: Record<GapLanguage, GapText> = {
  en: {
    connectionQuestion: (kinds, where, csv) =>
      `This workflow needs a ${kinds === '' ? '' : `${kinds} `}connection${where}, but no such connection is set up yet. ${csv ? 'Set one up in Settings first, or write the result to a CSV file instead?' : 'Set one up in Settings first?'}`,
    connectionSetup: 'Set up a connection first',
    connectionCsv: 'Write to a CSV file instead',
    folderQuestion: (where) => `This workflow uses a folder${where}, but no folder is allowed yet. Add the folder to the allowed folders in Settings first?`,
    folderAdd: 'Add the folder first',
    cancel: 'Cancel',
    summary: 'Before I can plan this, something has to be set up first.',
    missingConnection: (kinds, where) => `a ${kinds === '' ? '' : `${kinds} `}connection${where}`,
    missingFolder: (where) => `an allowed folder${where}`,
    planned: (missing) => `Still missing: ${missing}. I planned with the defaults; set this up in Settings before you activate the workflow.`,
    where: (ids) => (ids.length > 0 ? ` (needed by ${ids.join(', ')})` : ''),
  },
  ko: {
    connectionQuestion: (kinds, where, csv) =>
      `이 워크플로에는 ${kinds === '' ? '' : `${kinds} `}연결이 필요합니다${where}. 아직 설정된 연결이 없습니다. ${csv ? '먼저 설정에서 연결을 추가할까요, 아니면 결과를 CSV 파일에 기록할까요?' : '먼저 설정에서 연결을 추가할까요?'}`,
    connectionSetup: '먼저 연결 설정하기',
    connectionCsv: '대신 CSV 파일에 기록하기',
    folderQuestion: (where) => `이 워크플로는 폴더를 사용합니다${where}. 아직 허용된 폴더가 없습니다. 먼저 설정에서 허용 폴더에 추가할까요?`,
    folderAdd: '먼저 폴더 추가하기',
    cancel: '취소',
    summary: '계획하기 전에 먼저 설정해야 할 것이 있습니다.',
    missingConnection: (kinds, where) => `${kinds === '' ? '' : `${kinds} `}연결${where}`,
    missingFolder: (where) => `허용 폴더${where}`,
    planned: (missing) => `아직 없는 설정: ${missing}. 기본값으로 계획했습니다. 워크플로를 활성화하기 전에 설정에서 추가해 주세요.`,
    where: (ids) => (ids.length > 0 ? ` (${ids.join(', ')}에서 사용)` : ''),
  },
}

function nodeIdsOf(issues: readonly PlanIssue[], workflow: Workflow | undefined): string[] {
  const ids = issues.map((issue) => {
    const match = /^\/nodes\/(\d+)\//.exec(issue.pointer)
    return match ? workflow?.nodes[Number(match[1])]?.id : undefined
  })
  return [...new Set(ids.filter((id): id is string => id !== undefined))].sort()
}

interface GapParts {
  connection?: { kinds: string; where: string; webhookSecret: boolean }
  folder?: { where: string }
}

function gapParts(gaps: readonly PlanIssue[], workflow: Workflow | undefined, language: GapLanguage): GapParts {
  const text = GAP_TEXT[language]
  const parts: GapParts = {}
  const connection = gaps.filter((issue) => CONNECTION_GAP_CODES.includes(issue.code))
  if (connection.length > 0) {
    const sites = connection.map((issue) => connectionSiteAt(issue.pointer, workflow))
    const kinds = [...new Set(sites.map((site) => site?.kind).filter((kind): kind is ConnectionKind => kind !== undefined))].sort()
    parts.connection = {
      kinds: kinds.map((kind) => KIND_LABELS[language][kind]).join(', '),
      where: text.where(nodeIdsOf(connection, workflow)),
      webhookSecret: kinds.includes('webhookSecret'),
    }
  }
  const folder = gaps.filter((issue) => issue.code === 'path_outside_roots')
  if (folder.length > 0) parts.folder = { where: text.where(nodeIdsOf(folder, workflow)) }
  return parts
}

export function gapQuestions(
  gaps: readonly PlanIssue[],
  workflow: Workflow | undefined,
  language: GapLanguage = 'en',
): { questions: PlanQuestion[]; summary: string } {
  const text = GAP_TEXT[language]
  const parts = gapParts(gaps, workflow, language)
  const questions: PlanQuestion[] = []
  if (parts.connection !== undefined) {
    const { kinds, where, webhookSecret } = parts.connection
    questions.push({
      id: 'setup_connection',
      text: text.connectionQuestion(kinds, where, !webhookSecret),
      options: [text.connectionSetup, webhookSecret ? text.cancel : text.connectionCsv],
      default: text.connectionSetup,
    })
  }
  if (parts.folder !== undefined) {
    questions.push({ id: 'allow_folder', text: text.folderQuestion(parts.folder.where), options: [text.folderAdd, text.cancel], default: text.folderAdd })
  }
  return { questions, summary: text.summary }
}

export function gapSummary(summary: string, gaps: readonly PlanIssue[], workflow: Workflow | undefined, language: GapLanguage = 'en'): string {
  const text = GAP_TEXT[language]
  const parts = gapParts(gaps, workflow, language)
  const missing = [
    ...(parts.connection === undefined ? [] : [text.missingConnection(parts.connection.kinds, parts.connection.where)]),
    ...(parts.folder === undefined ? [] : [text.missingFolder(parts.folder.where)]),
  ]
  const line = text.planned(missing.join(language === 'ko' ? ', ' : '; '))
  return summary === '' ? line : `${summary}\n${line}`
}
