import { PROVIDER_IDS, providerDescriptor, type ProviderId } from '@rill/llm'
import { resolveEffort } from '@rill/planner'
import { money, plural, worstModelUsd } from './budget'
import { hostsOf, keyNeeds, missingKeysMessage, type KeyNeed, type ModelSpecInfo } from './providers'
import type { RunEstimate } from './runner'
import { SOFT_CAP_RESERVE_FACTOR, softCapFactor } from './spec'
import type { EvalCase, Suite } from './suite'

export function onlyClaude(infos: readonly ModelSpecInfo[]): boolean {
  return infos.every((info) => info.provider === 'anthropic')
}

export function keysSentence(infos: readonly ModelSpecInfo[]): string {
  const names = keyNeeds(infos, {}).map((need) => need.keyEnv)
  return names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export interface RunKeys {
  keyOf(spec: string): string
  secrets: string[]
  error: string | undefined
}

export function resolveKeys(infos: readonly ModelSpecInfo[], env: Readonly<Record<string, string | undefined>>): RunKeys {
  const needs = keyNeeds(infos, env)
  const missing = needs.filter((need) => !need.present)
  const byProvider = new Map<ProviderId, string>(needs.map((need) => [need.provider, env[need.keyEnv]?.trim() ?? '']))
  const byModel = new Map(infos.map((info) => [info.spec, byProvider.get(info.provider) ?? '']))
  let error: string | undefined
  if (missing.length > 0) {
    error = needs.length === 1 ? `${missing[0]?.keyEnv} is not set; --yes needs it in the environment` : missingKeysMessage(needs)
  }
  return {
    keyOf: (spec) => byModel.get(spec) ?? '',
    secrets: [...new Set([...byProvider.values()].filter((key) => key !== ''))],
    error,
  }
}

export function environmentSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  return PROVIDER_IDS.map((id) => env[providerDescriptor(id).keyEnv]?.trim() ?? '').filter((key) => key !== '')
}

export function hostList(infos: readonly ModelSpecInfo[], anthropicHost: string): string {
  const hosts = { ...hostsOf(infos) }
  if (hosts.anthropic !== undefined) hosts.anthropic = anthropicHost
  return [...new Set(Object.values(hosts))].join(', ')
}

export function otherHostLines(infos: readonly ModelSpecInfo[]): string[] {
  return Object.entries(hostsOf(infos))
    .filter(([provider]) => provider !== 'anthropic')
    .map(([, host]) => `API host: ${host}\n`)
}

function keyLine(need: KeyNeed, host: string | undefined): string {
  return `  ${need.label}: ${need.keyEnv} ${need.present ? 'set' : 'not set'}, ${host ?? 'unknown host'}`
}

export interface ProviderPlanInput<C extends EvalCase, O> {
  infos: readonly ModelSpecInfo[]
  env: Readonly<Record<string, string | undefined>>
  suite: Suite<C, O>
  estimate: RunEstimate
  reps: number
  maxOutputTokens: number
  efforts: readonly string[]
  anthropicHost: string
}

export function providerPlanLines<C extends EvalCase, O>(input: ProviderPlanInput<C, O>): string[] {
  const { infos, env, suite, estimate, reps, maxOutputTokens } = input
  if (onlyClaude(infos)) return []
  const hosts = { ...hostsOf(infos), anthropic: input.anthropicHost }
  const lines = ['', 'providers (the key each needs and the host your content goes to):', ...keyNeeds(infos, env).map((need) => keyLine(need, hosts[need.provider]))]
  lines.push('', 'by model (calls, typical cost, worst case with the max output tokens reserved for every call):')
  for (const entry of estimate.perModel) {
    const worst = worstModelUsd(suite, entry.model, maxOutputTokens, reps)
    const soft = softCapFactor(entry.model) > 1 ? ` (soft cap: hidden reasoning is not capped by max tokens, so the reserve counts ${SOFT_CAP_RESERVE_FACTOR} x the output)` : ''
    lines.push(`  ${entry.model}: ${plural(entry.calls, 'call')}, typical ${money(entry.usd)}, worst case ${money(worst)}${soft}`)
  }
  const notes: string[] = []
  for (const entry of estimate.perModel) {
    if (entry.notRun === undefined) continue
    const reasons = [...new Set((suite.cases().map((testCase) => suite.unsupportedReason?.(testCase, entry.model)).filter((reason): reason is string => reason !== undefined)))]
    notes.push(`  ${reasons.join('; ')}: ${plural(entry.notRun, 'case')} not run (n/a)`)
  }
  for (const info of infos) {
    for (const effort of input.efforts) {
      if (!isEffort(effort)) continue
      const resolved = resolveEffort(info.capabilities, effort)
      if (resolved.collapsed) notes.push(`  ${info.spec}: effort ${effort} runs as ${resolved.effective}`)
    }
  }
  if (notes.length > 0) lines.push('', 'capability notes:', ...notes)
  return lines
}

function isEffort(value: string): value is 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}
