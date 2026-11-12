import type { Workflow } from '@rill/dsl'
import type { NodeRegistry } from '@rill/nodes-core'
import { fold, occursIn, type LiteralKind } from '../attachments/normalize'
import { literalsIn } from '../attachments/redact'

export const HIDDEN = '<hidden>'
export const MAX_EXPLANATION_CHARS = 1500
export const MAX_REQUEST_CHARS = 400

const FORMAT = /(?!\p{Join_Control})\p{Cf}|[\u{e0100}-\u{e01ef}]/gu
const CONTROL = /[^\P{Cc}\n\t]/gu
const SEPARATOR = /[\p{Zl}\p{Zp}]/gu
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi
const EMAIL_LIKE = /[^\s@"'<>()[\]{},;:]+@[^\s@"'<>()[\]{},;]+\.[a-z]{2,}/gi
const SLACK_ID = /<[@#!][^>\s]{1,40}>/g
const HANDLE = /(?<![\w@.])[@#][a-z](?:[\w.-]{0,77}\w)?/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g
const HOST = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?![\w@-])/gi
const PATH = /(?<![\w.:/-])(?:~\/|[A-Za-z]:\\|\/)[^\s"'<>)\]}]+/g
const TAIL = /[.,;:!?]+$/
const PORT = /:\d{1,5}$/

const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'csv', 'tsv', 'txt', 'json', 'xml', 'yaml', 'yml', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'log', 'dat', 'bak', 'tmp', 'ini', 'conf', 'cfg', 'toml', 'html', 'htm',
])

export interface ScrubContext {
  workflow: Workflow
  registry: NodeRegistry
  digestText: string
}

export interface AnswerScrubber {
  explanation(text: string): string
  requestText(text: string): string
}

export function cleanText(text: string): string {
  return text.normalize('NFC').replace(SEPARATOR, '\n').replace(FORMAT, '').replace(CONTROL, '')
}

export function clampChars(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

function splitTail(text: string): { body: string; tail: string } {
  const tail = TAIL.exec(text)?.[0] ?? ''
  return { body: tail === '' ? text : text.slice(0, -tail.length), tail }
}

export function createAnswerScrubber(context: ScrubContext): AnswerScrubber {
  const { workflow, registry } = context
  const ids = new Set(workflow.nodes.map((node) => node.id))
  const titles = workflow.nodes.map((node) => registry.get(node.type)?.title ?? '')
  const corpus = fold([JSON.stringify(workflow), ...ids, ...titles].join('\n'))
  const digest = fold(context.digestText)
  const nodeTypes = new Set(registry.list().flatMap((def) => [fold(def.type), fold(def.type.replace(/@\d+$/, ''))]))

  const inCorpus = (value: string, kind: LiteralKind): boolean => occursIn(corpus, fold(value), kind)

  const urlTrusted = (url: string): boolean => {
    if (corpus.includes(fold(url))) return true
    try {
      return inCorpus(new URL(url).hostname.replace(/\.$/, ''), 'host')
    } catch {
      return false
    }
  }

  const hostTrusted = (token: string): boolean => {
    const host = token.replace(PORT, '')
    const labels = host.toLowerCase().split('.')
    if (token === host && FILE_EXTENSIONS.has(labels[labels.length - 1]!)) return true
    if (nodeTypes.has(fold(host))) return true
    if (ids.has(labels[0]!) && labels[1] === 'output') return true
    return inCorpus(host, 'host')
  }

  const hideTrailing = (text: string, pattern: RegExp, trusted: (body: string) => boolean): string =>
    text.replace(pattern, (match) => {
      const { body, tail } = splitTail(match)
      return trusted(body) ? match : `${HIDDEN}${tail}`
    })

  const hideDestinations = (text: string): string => {
    let out = hideTrailing(text, URL_LIKE, urlTrusted)
    out = out.replace(EMAIL_LIKE, (match) => (inCorpus(match, 'name') ? match : HIDDEN))
    out = out.replace(SLACK_ID, (match) => (corpus.includes(fold(match)) ? match : HIDDEN))
    out = out.replace(HANDLE, (match) => (inCorpus(match, 'name') ? match : HIDDEN))
    out = out.replace(IPV4, (match) => (inCorpus(match.replace(PORT, ''), 'host') ? match : HIDDEN))
    return out.replace(HOST, (match) => (hostTrusted(match) ? match : HIDDEN))
  }

  const hidePaths = (text: string, haystacks: readonly string[]): string =>
    hideTrailing(text, PATH, (path) => haystacks.some((haystack) => haystack.includes(fold(path))))

  const hideLiterals = (text: string): string => {
    let out = text
    for (const literal of new Set(literalsIn(text))) if (!corpus.includes(fold(literal))) out = out.replaceAll(literal, HIDDEN)
    return out
  }

  return {
    explanation: (text) => clampChars(hidePaths(hideDestinations(cleanText(text)), [corpus, digest]), MAX_EXPLANATION_CHARS),
    requestText: (text) => clampChars(hideLiterals(hidePaths(hideDestinations(cleanText(text)), [corpus])), MAX_REQUEST_CHARS),
  }
}
