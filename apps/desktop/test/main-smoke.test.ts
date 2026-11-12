// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { PING_QUERY, WINDOW_API_QUERY, runSmoke, type SmokeDeps } from '../src/main/smoke'
import { HOST_API_METHODS, type EngineInfo } from '../src/shared/host-api'

const TOKEN = 'smoke-token-SECRET-0123456789'

interface Options {
  windowApi?: boolean
  info?: EngineInfo | Error
  ping?: Array<{ state: string; ms: string | null } | null>
  loaded?: Promise<void>
  executeFails?: boolean
  stopHangs?: boolean
}

function setup(options: Options = {}) {
  const lines: string[] = []
  const exits: number[] = []
  const pings = [...(options.ping ?? [{ state: 'ok', ms: '12' }])]
  const executed: string[] = []
  const stop = vi.fn(() => (options.stopHangs === true ? new Promise<void>(() => undefined) : Promise.resolve()))
  const deps: SmokeDeps = {
    contents: {
      executeJavaScript: async (code: string) => {
        executed.push(code)
        if (options.executeFails === true) throw new Error(`page crashed ${TOKEN}`)
        if (code === WINDOW_API_QUERY) return options.windowApi ?? true
        if (code === PING_QUERY) return pings.length > 1 ? pings.shift() : (pings[0] ?? null)
        throw new Error('unexpected script')
      },
    },
    loaded: options.loaded ?? Promise.resolve(),
    supervisor: {
      info: async () => {
        const info = options.info ?? { url: 'ws://127.0.0.1:5/', token: TOKEN, protocol: 1 }
        if (info instanceof Error) throw info
        return info
      },
      stop,
    },
    print: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    versions: { electron: '45.3.0', node: '24.22.2' },
    timeoutMs: 200,
    stopTimeoutMs: 50,
    pollMs: 1,
  }
  return { deps, lines, exits, stop, executed }
}

describe('smoke mode', () => {
  it('prints one JSON line with the result of the whole chain and exits 0', async () => {
    const { deps, lines, exits, stop } = setup()
    await runSmoke(deps)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, windowApi: true, engine: true, ping: true, pingMs: 12, protocol: 1, electron: '45.3.0', node: '24.22.2' })
    expect(exits).toEqual([0])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('checks the window api against the real list of groups', () => {
    for (const group of Object.keys(HOST_API_METHODS)) expect(WINDOW_API_QUERY).toContain(`'${group}'`)
  })

  it('waits for the page to report its ping', async () => {
    const { deps, lines, exits } = setup({ ping: [null, null, { state: 'ok', ms: '7' }] })
    await runSmoke(deps)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, ping: true, pingMs: 7 })
    expect(exits).toEqual([0])
  })

  it('fails when window.rill is missing', async () => {
    const { deps, lines, exits } = setup({ windowApi: false })
    await runSmoke(deps)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, windowApi: false })
    expect(exits).toEqual([1])
  })

  it('fails when the engine does not come up, without a message from the error', async () => {
    const { deps, lines, exits } = setup({ info: new Error(`engine said ${TOKEN}`) })
    await runSmoke(deps)
    const report = JSON.parse(lines[0]!)
    expect(report).toMatchObject({ ok: false, engine: false, error: 'failed' })
    expect(lines[0]).not.toContain('SECRET')
    expect(exits).toEqual([1])
  })

  it('fails when the page reports a ping error', async () => {
    const { deps, lines, exits } = setup({ ping: [{ state: 'error', ms: null }] })
    await runSmoke(deps)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, windowApi: true, engine: true, ping: false })
    expect(exits).toEqual([1])
  })

  it('fails with a timeout when the page never reports, and still stops the engine', async () => {
    const { deps, lines, exits, stop } = setup({ ping: [null] })
    await runSmoke(deps)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, ping: false, error: 'timeout' })
    expect(exits).toEqual([1])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('fails with a timeout when the page never loads', async () => {
    const { deps, lines, exits } = setup({ loaded: new Promise<void>(() => undefined) })
    await runSmoke(deps)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, windowApi: false, engine: false, ping: false, error: 'timeout' })
    expect(exits).toEqual([1])
  })

  it('fails when the page cannot be queried, with a fixed error and no text from it', async () => {
    const { deps, lines, exits } = setup({ executeFails: true })
    await runSmoke(deps)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error: 'failed' })
    expect(lines[0]).not.toContain('SECRET')
    expect(exits).toEqual([1])
  })

  it('exits even when stopping the engine hangs', async () => {
    const { deps, exits } = setup({ stopHangs: true })
    await runSmoke(deps)
    expect(exits).toEqual([0])
  })

  it('never prints the engine token or address', async () => {
    const { deps, lines } = setup()
    await runSmoke(deps)
    expect(lines[0]).not.toContain(TOKEN)
    expect(lines[0]).not.toContain('ws://')
    expect(lines[0]).not.toContain('5/')
  })
})
