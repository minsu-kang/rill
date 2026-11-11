import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { LlmProvider, LlmRequest, LlmResult } from '@rill/llm'
import { amountToCents } from '../../normalize'
import { createRecorder, zeroUsage, type EvalProvider } from '../../record'
import { allNullOutput, oracleOutput, type Expected, type Output } from '../../score'
import { INJECTION_TARGETS, obeyedOutput } from './injection'
import type { ExtractCase } from './suite'

export const BASELINE_NAMES = ['all-null', 'oracle', 'regex'] as const
export type BaselineName = (typeof BASELINE_NAMES)[number]

export const OBEYING_NAME = 'obeying'

export const AMOUNT_KEYWORDS = ['total', '합계', '결제금액', '총 결제금액', '받을금액'] as const

interface AnswerEntry {
  seed: string
  expected: Expected
}

type AnswerTable = Map<string, AnswerEntry>

type SentDocument = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Buffer }

const TAGGED_TEXT = /^<(document-[0-9a-f]+)>\n([\s\S]*)\n<\/\1>$/u

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function textKey(text: string): string {
  return sha256(Buffer.from(text, 'utf8'))
}

export function buildAnswerTable(cases: readonly ExtractCase[]): AnswerTable {
  const table: AnswerTable = new Map()
  for (const testCase of cases) {
    const bytes = readFileSync(testCase.file)
    const key = testCase.kind === 'text' ? textKey(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : sha256(bytes)
    const known = table.get(key)
    if (known !== undefined && JSON.stringify(known.expected) !== JSON.stringify(testCase.expected)) {
      throw new Error(`fixtures of ${known.seed} and ${testCase.seed} are identical but expect different values`)
    }
    table.set(key, { seed: testCase.seed, expected: testCase.expected })
  }
  return table
}

export function findSentDocument(request: LlmRequest): SentDocument | undefined {
  for (const message of request.messages) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'text') {
        const match = TAGGED_TEXT.exec(part.text)
        if (match?.[2] !== undefined) return { kind: 'text', text: match[2] }
      } else {
        return { kind: 'binary', bytes: Buffer.from(part.data, 'base64') }
      }
    }
  }
  return undefined
}

function lookupAnswer(table: AnswerTable, request: LlmRequest): AnswerEntry {
  const document = findSentDocument(request)
  if (document === undefined) throw new Error('baseline: the request carries no document')
  const entry = table.get(document.kind === 'text' ? textKey(document.text) : sha256(document.bytes))
  if (entry === undefined) throw new Error('baseline: the document is not in the answer table')
  return entry
}

function result(name: string, data: unknown): LlmResult {
  return { data, usage: zeroUsage(), model: name, requestedModel: name, stopReason: 'end_turn', durationMs: 0, fallbackUsed: false }
}

function provider(name: string, answer: (request: LlmRequest) => Output): LlmProvider {
  return { name, generate: async (request) => result(name, answer(request)) }
}

export function oracleProvider(cases: readonly ExtractCase[]): LlmProvider {
  const table = buildAnswerTable(cases)
  return provider('oracle', (request) => oracleOutput(lookupAnswer(table, request).expected))
}

export function allNullProvider(): LlmProvider {
  return provider('all-null', () => allNullOutput())
}

export function obeyingProvider(cases: readonly ExtractCase[]): LlmProvider {
  const table = buildAnswerTable(cases)
  return provider(OBEYING_NAME, (request) => {
    const { seed, expected } = lookupAnswer(table, request)
    const target = INJECTION_TARGETS[seed]
    return target === undefined ? oracleOutput(expected) : obeyedOutput(target, expected)
  })
}

const NUMBER_TOKEN = /\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?|\d[\d.,']*\d|\d/gu

function lastNumber(line: string): number | null {
  const tokens = line.match(NUMBER_TOKEN) ?? []
  for (const token of tokens.reverse()) {
    const cents = amountToCents(token)
    if (cents !== null) return cents / 100
  }
  return null
}

function regexAmount(lines: readonly string[]): number | null {
  const matching = lines.filter((line) => {
    const lower = line.toLowerCase()
    return AMOUNT_KEYWORDS.some((keyword) => lower.includes(keyword)) && lastNumber(line) !== null
  })
  const last = matching.at(-1)
  return last === undefined ? null : lastNumber(last)
}

function isoDate(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text) ? text : null
}

function monthNumber(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1
}

interface DatePattern {
  pattern: RegExp
  build: (match: RegExpExecArray) => string | null
}

const DATE_PATTERNS: readonly DatePattern[] = [
  { pattern: /\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/gu, build: (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3])) },
  { pattern: /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu, build: (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3])) },
  {
    pattern: /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/giu,
    build: (m) => isoDate(Number(m[3]), monthNumber(m[2] ?? ''), Number(m[1])),
  },
  {
    pattern: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/giu,
    build: (m) => isoDate(Number(m[3]), monthNumber(m[1] ?? ''), Number(m[2])),
  },
  {
    pattern: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/gu,
    build: (m) => {
      const first = Number(m[1])
      const second = Number(m[2])
      return first > 12 ? isoDate(Number(m[3]), second, first) : isoDate(Number(m[3]), first, second)
    },
  },
  { pattern: /\b(\d{2})[./](\d{2})[./](\d{2})\b/gu, build: (m) => isoDate(2000 + Number(m[1]), Number(m[2]), Number(m[3])) },
]

function regexDate(text: string): string | null {
  const found: { index: number; iso: string }[] = []
  for (const { pattern, build } of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const iso = build(match)
      if (iso !== null) found.push({ index: match.index, iso })
    }
  }
  found.sort((left, right) => left.index - right.index)
  return found[0]?.iso ?? null
}

function regexVendor(lines: readonly string[]): string | null {
  const first = lines.map((line) => line.trim()).find((line) => line !== '')
  return first ?? null
}

export function regexExtract(text: string): Output {
  const lines = text.split('\n')
  return { amount: regexAmount(lines), date: regexDate(text), vendor: regexVendor(lines) }
}

export function regexProvider(): LlmProvider {
  return provider('regex', (request) => {
    const document = findSentDocument(request)
    return document?.kind === 'text' ? regexExtract(document.text) : allNullOutput()
  })
}

export const BASELINES: Readonly<Record<BaselineName, (cases: readonly ExtractCase[]) => LlmProvider>> = {
  'all-null': () => allNullProvider(),
  oracle: (cases) => oracleProvider(cases),
  regex: () => regexProvider(),
}

export function isBaselineName(name: string): name is BaselineName {
  return (BASELINE_NAMES as readonly string[]).includes(name)
}

export function fakeEvalProvider(provider: LlmProvider): EvalProvider {
  return { provider, recorder: createRecorder() }
}

export function baselineEvalProviders(cases: readonly ExtractCase[], names: readonly BaselineName[] = BASELINE_NAMES) {
  const providers = new Map<string, LlmProvider>(names.map((name) => [name, BASELINES[name](cases)]))
  return (model: string): EvalProvider => {
    const baseline = providers.get(model)
    if (baseline === undefined) throw new Error(`unknown baseline: ${model}`)
    return fakeEvalProvider(baseline)
  }
}
