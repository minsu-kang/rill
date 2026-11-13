import { replaceRefs, type PlanIssue, type Workflow } from '@rill/dsl'

export interface Policy {
  forbiddenNodes: readonly string[]
  allowedHosts: readonly string[]
}

export const HOST_RULE_NODE = 'http.request'

const MARK = '\u0001'
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i

export function baseNodeType(type: string): string {
  return type.replace(/@\d+$/, '')
}

export function isEmptyPolicy(policy: Policy | undefined): boolean {
  return policy === undefined || (policy.forbiddenNodes.length === 0 && policy.allowedHosts.length === 0)
}

export function hostOfUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname
  if (host === '' || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return undefined
  return host
}

export function hostMatches(host: string, pattern: string): boolean {
  const wanted = pattern.toLowerCase()
  if (!wanted.startsWith('*.')) return host === wanted
  const suffix = wanted.slice(1)
  const address = host.startsWith('[') || IPV4.test(host)
  return suffix.length > 1 && !address && host.length > suffix.length && host.endsWith(suffix)
}

export type UrlJudgement = { ok: true; host: string } | { ok: false; reason: 'invalid' } | { ok: false; reason: 'not_allowed'; host: string }

export function judgeUrl(url: string, patterns: readonly string[]): UrlJudgement {
  const host = hostOfUrl(url)
  if (host === undefined) return { ok: false, reason: 'invalid' }
  return patterns.some((pattern) => hostMatches(host, pattern)) ? { ok: true, host } : { ok: false, reason: 'not_allowed', host }
}

export function hostCheckFor(policy: Policy | undefined): ((url: string) => boolean) | undefined {
  if (policy === undefined || policy.allowedHosts.length === 0) return undefined
  const patterns = [...policy.allowedHosts]
  return (url) => judgeUrl(url, patterns).ok
}

export type ConfigUrlJudgement = UrlJudgement | { ok: false; reason: 'template' }

export function judgeConfigUrl(value: string, patterns: readonly string[]): ConfigUrlJudgement {
  const masked = replaceRefs(value, () => MARK)
  const authority = AUTHORITY.exec(masked)?.[1]
  if (authority === undefined) {
    const firstSlash = masked.search(/[/?#\\]/)
    const head = firstSlash === -1 ? masked : masked.slice(0, firstSlash)
    return head.includes(MARK) ? { ok: false, reason: 'template' } : { ok: false, reason: 'invalid' }
  }
  if (authority.includes(MARK)) return { ok: false, reason: 'template' }
  return judgeUrl(masked.replaceAll(MARK, 'x'), patterns)
}

function allowedHint(patterns: readonly string[]): string {
  return `allowed hosts: ${patterns.join(', ')}`
}

export function policyIssues(workflow: Workflow, policy: Policy | undefined): PlanIssue[] {
  if (policy === undefined || isEmptyPolicy(policy) || !Array.isArray(workflow.nodes)) return []
  const forbidden = new Set(policy.forbiddenNodes.map((type) => type.toLowerCase()))
  const issues: PlanIssue[] = []
  workflow.nodes.forEach((node, index) => {
    if (typeof node?.type !== 'string') return
    const base = baseNodeType(node.type)
    if (forbidden.has(base.toLowerCase())) {
      issues.push({
        stage: 3,
        pointer: `/nodes/${index}/type`,
        code: 'rule_violation',
        message: `node ${node.id}: the node type ${base} is forbidden by the rules`,
        hint: 'use another node type, or tell the user that this node type is not allowed',
      })
      return
    }
    if (policy.allowedHosts.length === 0 || base !== HOST_RULE_NODE) return
    const url = (node.config as Record<string, unknown> | null | undefined)?.url
    if (typeof url !== 'string') return
    const judged = judgeConfigUrl(url, policy.allowedHosts)
    if (judged.ok) return
    const pointer = `/nodes/${index}/config/url`
    const hint = allowedHint(policy.allowedHosts)
    const message =
      judged.reason === 'not_allowed'
        ? `node ${node.id}: the host ${judged.host} is not in the allowed hosts`
        : judged.reason === 'template'
          ? `node ${node.id}: the host of this URL is only known at run time; with allowed hosts set, write the host into the URL`
          : `node ${node.id}: the URL is not a valid absolute http or https URL`
    issues.push({ stage: 3, pointer, code: 'rule_violation', message, hint })
  })
  return issues
}
