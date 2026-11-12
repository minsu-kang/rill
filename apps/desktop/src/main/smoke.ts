import { RillClient } from '@rill/protocol'
import { HOST_API_METHODS, type EngineInfo } from '../shared/host-api'
import type { EngineSupervisor } from './engine-supervisor'

export interface SmokeDeps {
  contents: { executeJavaScript(code: string): Promise<unknown> }
  loaded: Promise<void>
  supervisor: Pick<EngineSupervisor, 'stop'> & { info(): Promise<EngineInfo> }
  print(line: string): void
  exit(code: number): void
  versions: { electron?: string; node?: string }
  seed?: (info: EngineInfo) => Promise<void>
  cspConsole: () => number
  timeoutMs?: number
  stopTimeoutMs?: number
  pollMs?: number
  settleMs?: number
}

interface Report {
  ok: boolean
  windowApi: boolean
  engine: boolean
  ping: boolean
  pingMs?: number
  appRendered: boolean
  graphRendered: boolean
  cspViolations: number
  cspConsoleMessages: number
  protocol?: number
  electron?: string
  node?: string
  error?: 'timeout' | 'failed'
}

export const WINDOW_API_QUERY = `(() => { const api = window.rill; return typeof api === 'object' && api !== null && [${Object.keys(HOST_API_METHODS)
  .map((group) => `'${group}'`)
  .join(', ')}].every((group) => typeof api[group] === 'object' && api[group] !== null) })()`

export const PING_QUERY =
  "(() => { const el = document.querySelector('[data-rill-ping]'); return el ? { state: el.getAttribute('data-rill-ping'), ms: el.getAttribute('data-rill-ping-ms') } : null })()"

export const APP_QUERY =
  "(() => { const regions = ['topbar', 'chat', 'workspace'].every((name) => document.querySelector('[data-rill-region=\"' + name + '\"]') !== null); const raw = document.documentElement.getAttribute('data-rill-csp-violations'); return { rendered: document.querySelector('[data-rill-app]') !== null && regions, graph: document.querySelector('.react-flow__node') !== null, violations: raw === null ? -1 : Number(raw) } })()"

export const REFRESH_QUERY = "(() => { window.dispatchEvent(new Event('focus')); return true })()"

export const SMOKE_WORKFLOW = {
  schemaVersion: 1,
  name: 'Smoke',
  nodes: [
    { id: 'start', type: 'trigger.manual@1', config: {} },
    { id: 'wait', type: 'delay@1', config: { ms: 1 } },
  ],
  edges: [{ from: 'start', to: 'wait' }],
}

async function defaultSeed(info: EngineInfo): Promise<void> {
  const client = await RillClient.connect(info.url, info.token)
  try {
    await client.request('deploy', { workflow: SMOKE_WORKFLOW })
  } finally {
    client.close()
  }
}

export function watchCspConsole(contents: { on(event: 'console-message', listener: (...args: unknown[]) => void): unknown }): () => number {
  let count = 0
  contents.on('console-message', (...args: unknown[]) => {
    const first = args[0]
    const message = typeof (first as { message?: unknown } | undefined)?.message === 'string' ? (first as { message: string }).message : args[2]
    if (typeof message === 'string' && message.includes('Content Security Policy')) count += 1
  })
  return () => count
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runSmoke(deps: SmokeDeps): Promise<void> {
  const report: Report = { ok: false, windowApi: false, engine: false, ping: false, appRendered: false, graphRendered: false, cspViolations: -1, cspConsoleMessages: -1 }
  const pollMs = deps.pollMs ?? 250

  async function work(): Promise<void> {
    await deps.loaded
    report.windowApi = (await deps.contents.executeJavaScript(WINDOW_API_QUERY)) === true
    const info = await deps.supervisor.info()
    report.engine = true
    report.protocol = info.protocol
    for (;;) {
      const found = (await deps.contents.executeJavaScript(PING_QUERY)) as { state: string | null; ms: string | null } | null
      if (found?.state === 'ok') {
        report.ping = true
        const ms = Number(found.ms)
        if (Number.isFinite(ms)) report.pingMs = ms
        break
      }
      if (found?.state === 'error') {
        await observe().catch(() => undefined)
        return
      }
      await sleep(pollMs)
    }
    await (deps.seed ?? defaultSeed)(info)
    await deps.contents.executeJavaScript(REFRESH_QUERY)
    for (;;) {
      await observe()
      if (report.appRendered && report.graphRendered) break
      await sleep(pollMs)
    }
    await sleep(deps.settleMs ?? 400)
    await observe()
  }

  async function observe(): Promise<void> {
    const seen = (await deps.contents.executeJavaScript(APP_QUERY)) as { rendered: boolean; graph: boolean; violations: number } | null
    report.appRendered = seen?.rendered === true
    report.graphRendered = seen?.graph === true
    report.cspViolations = typeof seen?.violations === 'number' ? seen.violations : -1
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? 45_000)
  })
  const outcome = await Promise.race([work().then(() => 'done' as const, () => 'failed' as const), timeout])
  clearTimeout(timer)
  if (outcome !== 'done') report.error = outcome
  try {
    report.cspConsoleMessages = deps.cspConsole()
  } catch {
    report.cspConsoleMessages = -1
  }
  report.ok = report.windowApi && report.engine && report.ping && report.appRendered && report.graphRendered && report.cspViolations === 0 && report.cspConsoleMessages === 0
  if (deps.versions.electron !== undefined) report.electron = deps.versions.electron
  if (deps.versions.node !== undefined) report.node = deps.versions.node
  deps.print(JSON.stringify(report))
  await Promise.race([deps.supervisor.stop().catch(() => undefined), sleep(deps.stopTimeoutMs ?? 15_000)])
  deps.exit(report.ok ? 0 : 1)
}
