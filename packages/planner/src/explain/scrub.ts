import { domainToASCII, domainToUnicode } from 'node:url'
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
const WORD = String.raw`\p{L}\p{M}\p{N}`
const JOINER_CHARS = String.raw`\u200c|\u200d`
const INNER = `(?:[${WORD}_-]|${JOINER_CHARS})`
const END = `(?:[${WORD}_]|${JOINER_CHARS})`
const LABEL = `[${WORD}_](?:${INNER}{0,61}${END})?`
const BEFORE = `(?<![${WORD}_@/-]|[${WORD}_]\\.)`
const AFTER = `(?![${WORD}_@-])`
const HOST = new RegExp(`${BEFORE}(?:${LABEL}\\.)+(?:xn--[a-z0-9-]{1,59}|[\\p{L}\\p{M}]{2,24})(?::\\d{1,5})?${AFTER}`, 'giu')
const DOTTED_PART = `[${WORD}](?:[${WORD}_-]|${JOINER_CHARS})*`
const DOTTED = new RegExp(`${BEFORE}${DOTTED_PART}(?:\\.${DOTTED_PART})+${AFTER}`, 'gu')
const TEMPLATE_REF = /\{\{\s*([A-Za-z0-9_]+)\.output(?:\.[A-Za-z0-9_]+|\[\d{1,4}\])*\s*\}\}/g
const JOINER = /[\u200c\u200d]/g
const LETTER = /\p{L}/u
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

  const hostForms = (host: string): string[] => {
    const plain = host.replace(JOINER, '')
    return [...new Set([plain, domainToASCII(plain), domainToUnicode(plain)].filter((form) => form !== ''))]
  }

  const hostInCorpus = (host: string): boolean => hostForms(host).some((form) => inCorpus(form, 'host'))

  const urlTrusted = (url: string): boolean => {
    if (corpus.includes(fold(url))) return true
    try {
      return hostInCorpus(new URL(url).hostname.replace(/\.$/, ''))
    } catch {
      return false
    }
  }

  const hostTrusted = (token: string): boolean => {
    const host = token.replace(PORT, '')
    const labels = host.toLowerCase().split('.')
    if (token === host && FILE_EXTENSIONS.has(labels[labels.length - 1]!)) return true
    if (nodeTypes.has(fold(host))) return true
    return hostInCorpus(host)
  }

  const hideTrailing = (text: string, pattern: RegExp, trusted: (body: string) => boolean): string =>
    text.replace(pattern, (match) => {
      const { body, tail } = splitTail(match)
      return trusted(body) ? match : `${HIDDEN}${tail}`
    })

  const hideAddresses = (text: string): string => {
    let out = hideTrailing(text, URL_LIKE, urlTrusted)
    out = out.replace(EMAIL_LIKE, (match) => (inCorpus(match, 'name') ? match : HIDDEN))
    out = out.replace(SLACK_ID, (match) => (corpus.includes(fold(match)) ? match : HIDDEN))
    out = out.replace(HANDLE, (match) => (inCorpus(match, 'name') ? match : HIDDEN))
    out = out.replace(IPV4, (match) => (inCorpus(match.replace(PORT, ''), 'host') ? match : HIDDEN))
    return out.replace(HOST, (match) => (hostTrusted(match) ? match : HIDDEN))
  }

  const hideDestinations = (text: string): string => {
    let out = ''
    let from = 0
    for (const match of text.matchAll(TEMPLATE_REF)) {
      if (!ids.has(match[1]!)) continue
      out += hideAddresses(text.slice(from, match.index)) + match[0]
      from = match.index + match[0].length
    }
    return out + hideAddresses(text.slice(from))
  }

  const hideDotted = (text: string): string =>
    text.replace(DOTTED, (token) => {
      const last = token.slice(token.lastIndexOf('.') + 1)
      if (!LETTER.test(token) || [...last].length < 2 || inCorpus(token, 'name')) return token
      return HIDDEN
    })

  const hidePaths = (text: string, haystacks: readonly string[]): string =>
    hideTrailing(text, PATH, (path) => haystacks.some((haystack) => haystack.includes(fold(path))))

  const hideLiterals = (text: string): string => {
    let out = text
    for (const literal of new Set(literalsIn(text))) if (!corpus.includes(fold(literal))) out = out.replaceAll(literal, HIDDEN)
    return out
  }

  return {
    explanation: (text) => clampChars(hidePaths(hideDestinations(cleanText(text)), [corpus, digest]), MAX_EXPLANATION_CHARS),
    requestText: (text) => clampChars(hideLiterals(hideDotted(hidePaths(hideDestinations(cleanText(text)), [corpus]))), MAX_REQUEST_CHARS),
  }
}
