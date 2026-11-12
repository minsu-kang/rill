import { roundUpBudget } from './budget'
import type { EvalProvider, EvalProviderOptions, FetchFn } from './record'
import type { PlannerFactory } from './suites/planner/suite'

export const DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2
export const EXIT_PARTIAL = 3
export const EXIT_INTERRUPTED = 130
export const SUGGESTED_BUDGET_FACTOR = 2
export const SDK_TIMEOUT_MARGIN_MS = 5000

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type SignalSubscriber = (handler: (signal: string) => void) => () => void

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Readonly<Record<string, string | undefined>>
  now: () => number
  fixturesDir?: string
  outRoot?: string
  onSignal?: SignalSubscriber
  planner?: PlannerCliHooks
  checkProvider?: { fetch?: FetchFn }
}

export interface PlannerCliHooks {
  makePlanner?: PlannerFactory
  createProvider?: (options: EvalProviderOptions) => EvalProvider
}

export function integerOption(name: string, raw: string | undefined, fallback: number, limits: { min: number; max: number }): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
    throw new UsageError(`${name} must be an integer from ${limits.min} to ${limits.max}`)
  }
  return value
}

export function listOption(name: string, raw: string): string[] {
  const items = raw.split(',').map((item) => item.trim())
  if (items.some((item) => item === '')) throw new UsageError(`${name} must be a comma separated list without empty entries`)
  if (new Set(items).size !== items.length) throw new UsageError(`${name} lists an entry twice`)
  return items
}

export function suggestedBudgetUsd(estimateUsd: number, reserveUsd = 0): number {
  return roundUpBudget(Math.max(estimateUsd * SUGGESTED_BUDGET_FACTOR, estimateUsd + reserveUsd))
}

export interface Endpoint {
  baseURL: string
  host: string
  isDefault: boolean
}

export function effectiveEndpoint(env: Readonly<Record<string, string | undefined>>): Endpoint {
  const raw = env['ANTHROPIC_BASE_URL']?.trim() ?? ''
  const baseURL = raw === '' ? DEFAULT_BASE_URL : raw
  let host: string
  try {
    const url = new URL(baseURL)
    host = url.host === '' ? baseURL : url.host
  } catch {
    throw new Error(`ANTHROPIC_BASE_URL is not a valid URL: ${baseURL}`)
  }
  return { baseURL, host, isDefault: baseURL.replace(/\/+$/u, '') === DEFAULT_BASE_URL }
}

export function endpointCheck(allowBaseUrl: boolean, io: CliIo, endpoint: Endpoint): boolean {
  io.stdout(`API host: ${endpoint.host}${endpoint.isDefault ? '' : ` (from ANTHROPIC_BASE_URL: ${endpoint.baseURL})`}\n`)
  const customHeaders = (io.env['ANTHROPIC_CUSTOM_HEADERS'] ?? '').trim() !== ''
  if (customHeaders) io.stderr('warning: ANTHROPIC_CUSTOM_HEADERS is set; the SDK adds those headers to every request\n')
  if (!allowBaseUrl) {
    if (!endpoint.isDefault) {
      io.stderr(
        `error: ANTHROPIC_BASE_URL points to ${endpoint.host}, not ${DEFAULT_BASE_URL}; your API key would be sent there. Unset it, or pass --allow-base-url if you mean it\n`,
      )
      return false
    }
    if (customHeaders) {
      io.stderr('error: ANTHROPIC_CUSTOM_HEADERS is set; unset it, or pass --allow-base-url to send those headers along with your key\n')
      return false
    }
  } else if (!endpoint.isDefault) {
    io.stdout(`WARNING: --allow-base-url is set: your API key will be sent to ${endpoint.host}, which is not ${DEFAULT_BASE_URL}\n`)
  }
  return true
}

export function interruptControls(io: CliIo, maxCallSeconds: number): { stop: AbortController; abort: AbortController; dispose: () => void } {
  const stop = new AbortController()
  const abort = new AbortController()
  const dispose =
    io.onSignal?.((signal) => {
      if (!stop.signal.aborted) {
        stop.abort()
        io.stderr(`\n${signal}: no new calls; waiting up to ${maxCallSeconds} s for the calls in flight, then writing a partial report. Send it again to abort them now.\n`)
        return
      }
      if (!abort.signal.aborted) {
        abort.abort()
        io.stderr(`\n${signal}: aborting the calls in flight.\n`)
      }
    }) ?? (() => undefined)
  return { stop, abort, dispose }
}

export function timestamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
}
