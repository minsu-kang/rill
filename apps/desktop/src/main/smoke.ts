import { HOST_API_METHODS, type EngineInfo } from '../shared/host-api'
import type { EngineSupervisor } from './engine-supervisor'

export interface SmokeDeps {
  contents: { executeJavaScript(code: string): Promise<unknown> }
  loaded: Promise<void>
  supervisor: Pick<EngineSupervisor, 'stop'> & { info(): Promise<EngineInfo> }
  print(line: string): void
  exit(code: number): void
  versions: { electron?: string; node?: string }
  timeoutMs?: number
  stopTimeoutMs?: number
  pollMs?: number
}

interface Report {
  ok: boolean
  windowApi: boolean
  engine: boolean
  ping: boolean
  pingMs?: number
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runSmoke(deps: SmokeDeps): Promise<void> {
  const report: Report = { ok: false, windowApi: false, engine: false, ping: false }
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
        return
      }
      if (found?.state === 'error') return
      await sleep(pollMs)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? 45_000)
  })
  const outcome = await Promise.race([work().then(() => 'done' as const, () => 'failed' as const), timeout])
  clearTimeout(timer)
  if (outcome !== 'done') report.error = outcome
  report.ok = report.windowApi && report.engine && report.ping
  if (deps.versions.electron !== undefined) report.electron = deps.versions.electron
  if (deps.versions.node !== undefined) report.node = deps.versions.node
  deps.print(JSON.stringify(report))
  await Promise.race([deps.supervisor.stop().catch(() => undefined), sleep(deps.stopTimeoutMs ?? 15_000)])
  deps.exit(report.ok ? 0 : 1)
}
