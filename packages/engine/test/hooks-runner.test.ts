import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookLogEntrySchema, HOOK_FAILURE_CODES } from '@rill/protocol'
import Value from 'typebox/value'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../src/db'
import { Engine } from '../src/engine'
import type { EngineEvent } from '../src/events'
import { HOOK_QUEUE_MAX } from '../src/hooks-runner'
import { BOT_TOKEN, WEBHOOK_URL, echoWorkflow, failingWorkflow, hookInput, notify, openEngine, slackJson, stubSlack, textOf } from './hook-helpers'
import { START, deployed, finished, finishedRun, logRows, outcomes, standalone, workflowIn } from './hook-runner-helpers'
import { ManualClock } from './manual-clock'
import { ScriptedProvider, plainWorkflow, planInput, workflowReply } from './plan-helpers'

const engines: Engine[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function setup(options: Parameters<typeof openEngine>[0] = {}) {
  const clock = new ManualClock(START)
  const opened = openEngine({ clock, ...options })
  engines.push(opened.engine)
  const events: EngineEvent[] = []
  opened.engine.on((event) => events.push(event))
  return { ...opened, clock, events }
}

describe('which events a hook acts on', () => {
  it('posts for a failed run with a run.failed hook and writes one ok row', async () => {
    const calls = stubSlack()
    const { engine, db, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('Receipts'))
    const hook = engine.saveHook(hookInput({ action: notify('team-slack') }))
    const result = await engine.startRun(workflowId, {})
    expect(result.status).toBe('failed')
    await engine.idle()
    expect(calls).toHaveLength(1)
    expect(textOf(calls[0]!)).toBe('Workflow "Receipts" failed.')
    expect(logRows(db)).toEqual([{ hook_id: hook.id, at: clock.now(), event: 'run.failed', workflow_id: workflowId, outcome: 'ok', code: null }])
  })

  it('posts for a succeeded run with a run.succeeded hook, with the finished sentence', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(echoWorkflow('Receipts'))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack') }))
    expect((await engine.startRun(workflowId, {})).status).toBe('succeeded')
    await engine.idle()
    expect(calls.map(textOf)).toEqual(['Workflow "Receipts" finished.'])
    expect(outcomes(db)).toEqual(['ok'])
  })

  it('does not act on a success for a run.failed hook, nor on a failure for a run.succeeded hook', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const good = engine.deploy(echoWorkflow('good'))
    const bad = engine.deploy(failingWorkflow('bad'))
    engine.saveHook(hookInput({ event: 'run.failed', action: notify('team-slack', '#a') }))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack', '#b') }))
    await engine.startRun(good, {})
    await engine.idle()
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['#b'])
    await engine.startRun(bad, {})
    await engine.idle()
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['#b', '#a'])
    expect(logRows(db)).toHaveLength(2)
  })

  it('acts for every workflow with a scope of all, and only for its own workflow with a workflow scope', async () => {
    stubSlack()
    const { engine, db } = setup()
    const one = engine.deploy(failingWorkflow('one'))
    const two = engine.deploy(failingWorkflow('two'))
    const everywhere = engine.saveHook(hookInput())
    const onlyTwo = engine.saveHook(hookInput({ scope: { type: 'workflow', workflowId: two } }))
    await engine.startRun(one, {})
    await engine.idle()
    expect(logRows(db).map((row) => [row.hook_id, row.workflow_id])).toEqual([[everywhere.id, one]])
    await engine.startRun(two, {})
    await engine.idle()
    expect(logRows(db).map((row) => [row.hook_id, row.workflow_id])).toEqual([
      [everywhere.id, one],
      [everywhere.id, two],
      [onlyTwo.id, two],
    ])
  })

  it('does nothing for a hook that is switched off, and starts again when it is switched on', async () => {
    const calls = stubSlack()
    const { engine, db, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    const hook = engine.saveHook(hookInput({ action: notify('team-slack'), enabled: false }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(logRows(db)).toEqual([])
    engine.saveHook({ ...hookInput({ action: notify('team-slack'), enabled: true }), id: hook.id })
    clock.jump(1000)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(1)
    engine.saveHook({ ...hookInput({ action: notify('team-slack'), enabled: false }), id: hook.id })
    clock.jump(120_000)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(1)
  })

  it('ignores dry runs, whether they fail or succeed, and writes no row for them', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const bad = engine.deploy(failingWorkflow('bad'))
    const good = engine.deploy(echoWorkflow('good'))
    engine.saveHook(hookInput({ action: notify('team-slack', '#a') }))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack', '#b') }))
    expect((await engine.startRun(bad, {}, { dryRun: true })).status).toBe('failed')
    expect((await engine.startRun(good, {}, { dryRun: true })).status).toBe('succeeded')
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(logRows(db)).toEqual([])
  })

  it('takes the workflow from the run record, because the event has only the run id', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    const events: EngineEvent[] = []
    engine.on((event) => events.push(event))
    engine.saveHook(hookInput())
    await engine.startRun(workflowId, {})
    await engine.idle()
    const finishedEvent = events.find((event) => event.type === 'run.finished')!
    expect(Object.keys(finishedEvent).sort()).toEqual(['at', 'error', 'runId', 'status', 'type'])
    expect(logRows(db)[0]!.workflow_id).toBe(workflowId)
  })

  it('acts on plan.deployed for a plan that is deployed, once, and for the scope of the workflow it made', async () => {
    const calls = stubSlack()
    const provider = new ScriptedProvider([{ data: workflowReply(plainWorkflow('Shipped')) }])
    const { engine, db } = setup({ llm: provider })
    await engine.plan(planInput())
    const hereAfter = engine.saveHook(hookInput({ event: 'plan.deployed', action: notify('team-slack') }))
    engine.saveHook(hookInput({ event: 'run.failed', action: notify('team-slack', '#fail') }))
    const workflowId = engine.deployPlan('plan-1', [])
    await engine.idle()
    expect(calls.map(textOf)).toEqual(['Workflow "Shipped" was deployed.'])
    expect(logRows(db)).toEqual([{ hook_id: hereAfter.id, at: expect.any(Number), event: 'plan.deployed', workflow_id: workflowId, outcome: 'ok', code: null }])
  })

  it('ignores the events that are not hook events', async () => {
    const calls = stubSlack()
    const { runner, db, store } = standalone()
    const workflowId = workflowIn(store, 'w')
    store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    const others: EngineEvent[] = [
      { type: 'run.started', at: 1, runId: 'r', workflowId, dryRun: false },
      { type: 'step.failed', at: 1, runId: 'r', nodeId: 'n', attempt: 1, error: 'x', willRetry: false },
      { type: 'trigger.fired', at: 1, workflowId, runId: 'r' },
      { type: 'trigger.error', at: 1, workflowId, error: 'x' },
      { type: 'workflow.activated', at: 1, workflowId },
      { type: 'workflow.deactivated', at: 1, workflowId },
      { type: 'workflow.deleted', at: 1, workflowId },
      { type: 'run.blocked', at: 1, workflowId, codes: ['rule_violation'] },
    ]
    for (const event of others) runner.handle(event)
    await runner.idle()
    expect(logRows(db)).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('when a hook acts', () => {
  it('starts after the other listeners have seen the event and after the run has returned', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput())
    const order: string[] = []
    engine.on((event) => {
      if (event.type === 'run.finished') order.push(`listener sees ${logRows(db).length} rows`)
    })
    await engine.startRun(workflowId, {})
    order.push(`run returned with ${logRows(db).length} rows`)
    await engine.idle()
    order.push(`idle with ${logRows(db).length} rows`)
    expect(order).toEqual(['listener sees 0 rows', 'run returned with 0 rows', 'idle with 1 rows'])
  })

  it('skips a hook that was deleted after the event and before its turn', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    const hook = engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, {})
    engine.deleteHook(hook.id)
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(logRows(db)).toEqual([])
  })

  it('uses the hooks as they are when its turn comes, so a hook that was added meanwhile acts', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ event: 'run.failed', action: { type: 'record' } }))
    await engine.startRun(workflowId, {})
    const later = engine.saveHook(hookInput({ event: 'run.failed', scope: { type: 'workflow', workflowId } }))
    await engine.idle()
    expect(logRows(db).map((row) => row.hook_id)).toContain(later.id)
  })

  it('runs the hooks one after the other in the order of their creation', async () => {
    let inFlight = 0
    let overlap = 0
    const calls = stubSlack(async () => {
      inFlight += 1
      overlap = Math.max(overlap, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight -= 1
      return slackJson({ ok: true })
    })
    const { engine } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    for (const channel of ['#one', '#two', '#three', '#four']) engine.saveHook(hookInput({ action: notify('team-slack', channel) }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['#one', '#two', '#three', '#four'])
    expect(overlap).toBe(1)
  })

  it('waits for a hook that is still posting when the engine is idle, and the run does not wait for it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = stubSlack(async () => {
      await gate
      return slackJson({ ok: true })
    })
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    const started = Date.now()
    await engine.startRun(workflowId, {})
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toHaveLength(1)
    expect(logRows(db)).toEqual([])
    expect(Date.now() - started).toBeLessThan(5000)
    let idle = false
    const waiting = engine.idle().then(() => {
      idle = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(idle).toBe(false)
    release()
    await waiting
    expect(outcomes(db)).toEqual(['ok'])
  })

  it('does not lose a run that finishes while the runner is busy with another', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const calls = stubSlack(async () => {
      if (first) {
        first = false
        await gate
      }
      return slackJson({ ok: true })
    })
    const { engine, db } = setup()
    const one = engine.deploy(failingWorkflow('one'))
    const two = engine.deploy(failingWorkflow('two'))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(one, {})
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(outcomes(db)).toEqual(['ok'])
    expect(calls).toHaveLength(1)
    await engine.startRun(two, {})
    await engine.startRun(two, {})
    release()
    await engine.idle()
    expect(logRows(db).map((row) => row.workflow_id)).toEqual([one, one, two, two, two, two])
    expect(outcomes(db)).toEqual(['ok', 'ok', 'ok', 'skipped_cooldown', 'ok', 'skipped_cooldown'])
  })
})

describe('the queue of the runner', () => {
  async function backlog(waiting: number) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    stubSlack(async () => {
      if (first) {
        first = false
        await gate
      }
      return slackJson({ ok: true })
    })
    const { store, runner } = standalone()
    const workflowId = workflowIn(store, 'w')
    store.saveHook(hookInput({ action: notify('team-slack') }))
    store.saveHook(hookInput({ action: { type: 'record' } }))
    const runIds = Array.from({ length: waiting + 1 }, () => finishedRun(store, workflowId, 'failed'))
    const read = vi.spyOn(store, 'getRunSummary')
    runner.handle(finished(runIds[0]!, 'failed', START))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    for (let index = 1; index <= waiting; index++) runner.handle(finished(runIds[index]!, 'failed', START + index))
    release()
    await runner.idle()
    return { runIds, handled: read.mock.calls.map((call) => call[0]) }
  }

  it('holds at most 1000 waiting events and drops the oldest ones, so that the newest failures still decide', async () => {
    expect(HOOK_QUEUE_MAX).toBe(1000)
    const { runIds, handled } = await backlog(HOOK_QUEUE_MAX + 10)
    expect(handled).toEqual([runIds[0], ...runIds.slice(11)])
  })

  it('keeps every event while the queue is not over the limit', async () => {
    const { runIds, handled } = await backlog(HOOK_QUEUE_MAX)
    expect(handled).toEqual(runIds)
  })
})

describe('the message', () => {
  it('names the workflow and the event and nothing from the run', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const MARKER = 'RUN-DATA-MARKER-31c9'
    const workflowId = engine.deploy({
      schemaVersion: 1,
      name: 'Receipts',
      nodes: [
        { id: 'secret_node_name', type: 'trigger.manual@1', config: {} },
        { id: 'n1', type: 'test.fail@1', config: {} },
      ],
      edges: [{ from: 'secret_node_name', to: 'n1' }],
    })
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, { path: `/Users/someone/${MARKER}.pdf`, amount: MARKER })
    await engine.idle()
    expect(calls).toHaveLength(1)
    const sent = calls[0]!.body
    expect(textOf(calls[0]!)).toBe('Workflow "Receipts" failed.')
    for (const leak of [MARKER, 'permanent', 'secret_node_name', 'n1', '/Users', '.pdf', 'node ']) expect(sent, leak).not.toContain(leak)
    expect(JSON.stringify(logRows(db))).not.toContain(MARKER)
  })

  it.each([
    ['<!channel>', 'Workflow "&lt;!channel&gt;" failed.'],
    ['<@U123>', 'Workflow "&lt;@U123&gt;" failed.'],
    ['<!here|here> & <http://evil.example|click>', 'Workflow "&lt;!here|here&gt; &amp; &lt;http://evil.example|click&gt;" failed.'],
    ['a\nb\tc\u0000d', 'Workflow "abcd" failed.'],
    ['x\u202e<!channel>', 'Workflow "x&lt;!channel&gt;" failed.'],
    ['a\u200bb\u2060c\ufeffd\u00ade', 'Workflow "abcde" failed.'],
    ['a\u2028b\u2029c', 'Workflow "abc" failed.'],
    ['  two   spaces  ', 'Workflow "two spaces" failed.'],
    ['\u200b\u200b', 'Workflow "unnamed" failed.'],
    ['y'.repeat(200), `Workflow "${'y'.repeat(60)}" failed.`],
    ['&'.repeat(200), `Workflow "${'&amp;'.repeat(60)}" failed.`],
  ])('makes the workflow name %j safe', async (name, expected) => {
    const calls = stubSlack()
    const { engine } = setup()
    const workflowId = engine.deploy(failingWorkflow(name))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(textOf(calls[0]!)).toBe(expected)
    expect(textOf(calls[0]!)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u)
  })

  it('has the three fixed sentences, one per event', async () => {
    const calls = stubSlack()
    const { engine } = setup()
    const bad = engine.deploy(failingWorkflow('W'))
    const good = engine.deploy(echoWorkflow('W2'))
    engine.saveHook(hookInput({ event: 'run.failed', action: notify('team-slack', '#a') }))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: notify('team-slack', '#b') }))
    await engine.startRun(bad, {})
    await engine.startRun(good, {})
    await engine.idle()
    expect(calls.map(textOf).sort()).toEqual(['Workflow "W" failed.', 'Workflow "W2" finished.'])
  })

  it('has the deployed sentence for a plan.deployed event', async () => {
    const calls = stubSlack()
    const { runner, store } = standalone()
    const workflowId = workflowIn(store, 'Deployed one')
    store.saveHook({ event: 'plan.deployed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack' }, enabled: true })
    runner.handle(deployed(workflowId, START + 5))
    await runner.idle()
    expect(calls.map(textOf)).toEqual(['Workflow "Deployed one" was deployed.'])
  })
})

describe('the Slack call', () => {
  it('goes to chat.postMessage for a bot connection with the token only in the header, and uses the default channel', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    const call = calls[0]!
    expect(call.url).toBe('https://slack.com/api/chat.postMessage')
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Bearer ${BOT_TOKEN}`)
    expect(call.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(call.redirect).toBe('manual')
    expect(JSON.parse(call.body)).toEqual({ channel: '#default', text: 'Workflow "w" failed.' })
    expect(call.body).not.toContain(BOT_TOKEN)
    expect(JSON.stringify(logRows(db))).not.toContain(BOT_TOKEN)
  })

  it('prefers the channel of the hook over the default channel of the connection', async () => {
    const calls = stubSlack()
    const { engine } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack', '#from-hook') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(JSON.parse(calls[0]!.body).channel).toBe('#from-hook')
  })

  it('writes failed with the code connection when a bot connection has no channel at all', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('bare-bot') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(outcomes(db)).toEqual(['failed:connection'])
  })

  it('posts only the text to the url of a webhook connection, with no authorization', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('hook-slack') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(WEBHOOK_URL)
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.headers.get('authorization')).toBeNull()
    expect(JSON.parse(call.body)).toEqual({ text: 'Workflow "w" failed.' })
    expect(JSON.stringify(logRows(db))).not.toContain('HOOKWEBHOOKMARKER')
    expect(outcomes(db)).toEqual(['ok'])
  })

  it('writes failed with the code connection for a webhook connection and a channel, and sends nothing', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('hook-slack', '#nope') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(outcomes(db)).toEqual(['failed:connection'])
  })

  it('looks the connection up again at run time: a removed, retyped or malformed one is a failed row with the code connection', async () => {
    const calls = stubSlack()
    const { engine, db, table, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    table.remove('team-slack')
    await engine.startRun(workflowId, {})
    await engine.idle()
    clock.jump(120_000)
    table.setTyped('team-slack', BOT_TOKEN, 'http')
    await engine.startRun(workflowId, {})
    await engine.idle()
    clock.jump(120_000)
    table.setTyped('team-slack', 'not-a-slack-secret', 'slack')
    await engine.startRun(workflowId, {})
    await engine.idle()
    clock.jump(120_000)
    table.setPlain('team-slack', WEBHOOK_URL)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(outcomes(db)).toEqual(['failed:connection', 'failed:connection', 'failed:connection', 'failed:connection'])
  })

  it.each([
    ['Slack says ok false', () => slackJson({ ok: false, error: 'channel_not_found' }), 'failed:slack_error'],
    ['Slack answers with something else', () => new Response('<html></html>', { status: 200 }), 'failed:slack_error'],
    ['a server error', () => new Response('x', { status: 500 }), 'failed:http_status'],
    ['a rate limit', () => new Response('x', { status: 429 }), 'failed:http_status'],
    ['a forbidden answer', () => new Response('SECRET-ECHO', { status: 403 }), 'failed:http_status'],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 'failed:http_status'],
  ])('writes %s as a failed row with a fixed code, makes one attempt and shows no text from Slack', async (_label, respond, expected) => {
    const calls = stubSlack(respond)
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(1)
    expect(outcomes(db)).toEqual([expected])
    expect(JSON.stringify(logRows(db))).not.toMatch(/channel_not_found|SECRET-ECHO|evil|html/)
  })

  it('writes a timeout as the code timeout and another network error as the code unknown', async () => {
    const { engine, db, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError')
    })
    await engine.startRun(workflowId, {})
    await engine.idle()
    clock.jump(120_000)
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`fetch failed ${BOT_TOKEN}`, { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })
    })
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(outcomes(db)).toEqual(['failed:timeout', 'failed:unknown'])
    expect(JSON.stringify(logRows(db))).not.toContain(BOT_TOKEN)
  })

  it('gives the post 15 seconds, as the node does', async () => {
    stubSlack()
    const { engine } = setup()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(timeout).toHaveBeenCalledWith(15_000)
  })

  it('writes the code timeout for a post that outlasts the time of the runner, and the next hook still acts', async () => {
    const calls = stubSlack((call) => {
      if (JSON.parse(call.body).channel === '#slow') return new Promise<Response>((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(call.signal?.reason)))
      return slackJson({ ok: true })
    })
    const { runner, store, db } = standalone({ timeoutMs: 20 })
    const workflowId = workflowIn(store, 'w')
    store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#slow' }, enabled: true })
    store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'notify', connection: 'team-slack', channel: '#fast' }, enabled: true })
    runner.handle(finished(finishedRun(store, workflowId, 'failed'), 'failed', START + 10))
    await runner.idle()
    expect(calls.map((call) => JSON.parse(call.body).channel)).toEqual(['#slow', '#fast'])
    expect(outcomes(db)).toEqual(['failed:timeout', 'ok'])
  })
})

describe('the rules of Plan 10 at run time', () => {
  it('writes blocked_by_rule for a notify hook while a rule forbids notify.slack, sends nothing and does not start a cooldown', async () => {
    const calls = stubSlack()
    const { engine, db, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    const rule = engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' })
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(0)
    expect(outcomes(db)).toEqual(['blocked_by_rule'])
    engine.deleteRule(rule.id)
    clock.jump(1000)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(1)
    expect(outcomes(db)).toEqual(['blocked_by_rule', 'ok'])
  })

  it('does not block a record hook, and does not block for a rule about another node', async () => {
    const calls = stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    engine.saveRule({ kind: 'forbidNode', value: 'http.request' })
    engine.saveRule({ kind: 'allowHost', value: 'api.example.com' })
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(calls).toHaveLength(1)
    expect(outcomes(db)).toEqual(['ok', 'ok'])
  })

  it('writes blocked_by_rule for the record hook never, even when notify.slack is forbidden', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    engine.saveRule({ kind: 'forbidNode', value: 'notify.slack' })
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(outcomes(db)).toEqual(['ok'])
  })
})

describe('a hook never disturbs a run, an event or another hook', () => {
  it('catches a hook that throws, logs it as failed with the code unknown and goes on with the next one', async () => {
    const calls = stubSlack()
    const { engine, db, table } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack', '#one') }))
    engine.saveHook(hookInput({ action: notify('team-slack', '#two') }))
    const real = table.resolver.get
    let thrown = false
    table.resolver.get = (id) => {
      if (!thrown) {
        thrown = true
        throw new Error('resolver broke: SECRET-RESOLVER-TEXT')
      }
      return real(id)
    }
    const result = await engine.startRun(workflowId, {})
    await engine.idle()
    expect(result.status).toBe('failed')
    expect(outcomes(db)).toEqual(['failed:unknown', 'ok'])
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(logRows(db))).not.toContain('SECRET-RESOLVER-TEXT')
  })

  it('does not let a failing post stop later hooks, later runs or the other listeners', async () => {
    stubSlack(() => {
      throw new Error('fetch broke')
    })
    const { engine, db, events, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    const seen: string[] = []
    engine.on((event) => seen.push(event.type))
    expect((await engine.startRun(workflowId, {})).status).toBe('failed')
    await engine.idle()
    clock.jump(120_000)
    expect((await engine.startRun(workflowId, {})).status).toBe('failed')
    await engine.idle()
    expect(outcomes(db)).toEqual(['failed:unknown', 'ok', 'failed:unknown', 'ok'])
    expect(seen.filter((type) => type === 'run.finished')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(2)
  })

  it('does not slow the run: a second run finishes while the first hook is still posting', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    stubSlack(async () => {
      await gate
      return slackJson({ ok: true })
    })
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    await engine.startRun(workflowId, {})
    await new Promise((resolve) => setImmediate(resolve))
    const second = await engine.startRun(workflowId, {})
    expect(second.status).toBe('failed')
    expect(logRows(db)).toEqual([])
    release()
    await engine.idle()
    expect(logRows(db)).toHaveLength(2)
  })

  it('aborts a post that is still in flight when the engine shuts down, and keeps nothing queued', async () => {
    const calls = stubSlack((call) => new Promise<Response>((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(call.signal?.reason))))
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    await engine.startRun(workflowId, {})
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toHaveLength(1)
    const started = Date.now()
    await engine.shutdown()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(outcomes(db)).toEqual(['failed:unknown'])
  })

  it('never starts a run, a plan, a deploy or a model call, whatever the hooks do', async () => {
    stubSlack()
    const provider = new ScriptedProvider([{ data: workflowReply(plainWorkflow('Shipped')) }])
    const { engine, db } = setup({ llm: provider })
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput({ action: notify('team-slack') }))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    engine.saveHook(hookInput({ action: { type: 'deactivateAfterFailures', count: 2 } }))
    engine.saveHook(hookInput({ event: 'run.succeeded', action: { type: 'record' } }))
    engine.saveHook(hookInput({ event: 'plan.deployed', action: notify('team-slack') }))
    engine.saveHook(hookInput({ event: 'plan.deployed', action: { type: 'record' } }))
    await engine.plan(planInput())
    const planned = provider.requests.length
    const before = tables(db)
    await engine.startRun(workflowId, {})
    await engine.startRun(workflowId, {})
    engine.deployPlan('plan-1', [])
    await engine.idle()
    const after = tables(db)
    expect(after.runs - before.runs).toBe(2)
    expect(after.plans).toBe(before.plans)
    expect(after.workflows - before.workflows).toBe(1)
    expect(after.step_attempts - before.step_attempts).toBe(2)
    expect(provider.requests).toHaveLength(planned)
    expect(logRows(db).length).toBeGreaterThanOrEqual(5)
  })
})

describe('a failure inside the runner', () => {
  it('does not stop the next event when the hooks cannot be read for a job', async () => {
    const { runner, store, db } = standalone()
    const workflowId = workflowIn(store, 'w')
    const runId = finishedRun(store, workflowId, 'failed')
    store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    runner.handle(finished(runId, 'failed', START))
    store.saveHook({ event: 'run.failed', scope: { type: 'workflow', workflowId }, action: { type: 'record' }, enabled: true })
    vi.spyOn(store, 'listHooks').mockImplementationOnce(() => {
      throw new Error('the database is gone')
    })
    await expect(runner.idle()).resolves.toBeUndefined()
    expect(logRows(db)).toEqual([])
    runner.handle(finished(runId, 'failed', START + 1))
    await runner.idle()
    expect(outcomes(db)).toEqual(['ok', 'ok'])
  })

  it('goes on with the hooks behind a hook whose log row cannot be written', async () => {
    const { runner, store, db } = standalone()
    const workflowId = workflowIn(store, 'w')
    const runId = finishedRun(store, workflowId, 'failed')
    store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    store.saveHook({ event: 'run.failed', scope: { type: 'workflow', workflowId }, action: { type: 'record' }, enabled: true })
    vi.spyOn(store, 'appendHookLog').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    runner.handle(finished(runId, 'failed', START))
    await expect(runner.idle()).resolves.toBeUndefined()
    expect(logRows(db).map((row) => row.outcome)).toEqual(['ok'])
  })
})

describe('with no hook at all', () => {
  it('does no work for an event: no query, no timer, no row', async () => {
    const calls = stubSlack()
    const { runner, db, store } = standalone()
    const workflowId = workflowIn(store, 'w')
    const runId = finishedRun(store, workflowId, 'failed')
    const spies = (['get', 'all', 'run', 'exec', 'transaction'] as const).map((method) => vi.spyOn(db, method))
    const immediate = vi.spyOn(globalThis, 'setImmediate')
    const storeSpies = (['getRunSummary', 'listHooks', 'workflowName', 'listRules'] as const).map((method) => vi.spyOn(store, method as 'listHooks'))
    for (let index = 0; index < 20; index++) {
      runner.handle(finished(runId, 'failed', START + index))
      runner.handle(finished(runId, 'succeeded', START + index))
      runner.handle(deployed(workflowId, START + index))
    }
    await runner.idle()
    for (const spy of [...spies, ...storeSpies, immediate]) expect(spy).not.toHaveBeenCalled()
    expect(logRows(db)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('does no work for an event nobody asked for even when other hooks exist, and reads nothing for it', async () => {
    const { runner, db, store } = standalone()
    const workflowId = workflowIn(store, 'w')
    const runId = finishedRun(store, workflowId, 'failed')
    store.saveHook({ event: 'plan.deployed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    store.saveHook({ event: 'run.succeeded', scope: { type: 'all' }, action: { type: 'record' }, enabled: false })
    const get = vi.spyOn(db, 'get')
    const all = vi.spyOn(db, 'all')
    const run = vi.spyOn(db, 'run')
    runner.handle(finished(runId, 'failed', START))
    runner.handle(finished(runId, 'succeeded', START))
    await runner.idle()
    expect(all).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    runner.handle(finished(runId, 'failed', START + 1))
    await runner.idle()
    expect(all).toHaveBeenCalledTimes(1)
    expect(logRows(db)).toEqual([])
  })

  it('keeps an engine without hooks exactly as it was: runs and plans leave no hook row and call no hook query', async () => {
    const calls = stubSlack()
    const provider = new ScriptedProvider([{ data: workflowReply(plainWorkflow('Shipped')) }])
    const { engine, db } = setup({ llm: provider })
    const listHooks = vi.spyOn(engine.store, 'listHooks')
    const log = vi.spyOn(engine.store, 'appendHookLog')
    const summary = vi.spyOn(engine.store, 'getRunSummary')
    const good = engine.deploy(echoWorkflow('good'))
    const bad = engine.deploy(failingWorkflow('bad'))
    await engine.startRun(good, {})
    await engine.startRun(bad, {})
    await engine.plan(planInput())
    engine.deployPlan('plan-1', [])
    await engine.idle()
    expect(listHooks).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(summary).not.toHaveBeenCalled()
    expect(logRows(db)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('reads the hooks again after a change and not before', async () => {
    stubSlack()
    const { engine, db } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    const listHooks = vi.spyOn(engine.store, 'listHooks')
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(listHooks).not.toHaveBeenCalled()
    engine.saveHook(hookInput())
    await engine.startRun(workflowId, {})
    await engine.startRun(workflowId, {})
    await engine.idle()
    const reads = listHooks.mock.calls.length
    expect(reads).toBeGreaterThanOrEqual(1)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(listHooks.mock.calls.length).toBe(reads)
    expect(logRows(db)).toHaveLength(3)
  })
})

describe('a restart', () => {
  it('replays nothing: a run that finished before the restart is not announced again', async () => {
    const calls = stubSlack()
    const dir = mkdtempSync(join(tmpdir(), 'rill-hooks-restart-'))
    const file = join(dir, 'rill.db')
    try {
      const firstDb = Db.open(file)
      const first = openEngine({ db: firstDb, clock: new ManualClock(START) })
      const workflowId = first.engine.deploy(failingWorkflow('w'))
      first.engine.saveHook(hookInput({ action: notify('team-slack') }))
      await first.engine.startRun(workflowId, {})
      await first.engine.shutdown()
      expect(calls).toHaveLength(0)
      expect(logRows(firstDb)).toEqual([])
      firstDb.close()

      const secondDb = Db.open(file)
      const second = openEngine({ db: secondDb, clock: new ManualClock(START + 60_000) })
      engines.push(second.engine)
      expect(second.engine.listHooks()).toHaveLength(1)
      await second.engine.recover()
      await second.engine.resumeActive()
      await second.engine.idle()
      expect(calls).toHaveLength(0)
      expect(logRows(secondDb)).toEqual([])
      await second.engine.shutdown()
      engines.length = 0
      secondDb.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the log rows', () => {
  it('pass the protocol schema, hold only fixed codes, and name no workflow, connection, channel or text', async () => {
    stubSlack((call) => (JSON.parse(call.body).channel === '#bad' ? slackJson({ ok: false, error: 'channel_not_found' }) : slackJson({ ok: true })))
    const { engine, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('Secret Workflow Name'))
    engine.saveHook(hookInput({ action: notify('team-slack', '#bad') }))
    engine.saveHook(hookInput({ action: notify('hook-slack') }))
    engine.saveHook(hookInput({ action: { type: 'record' } }))
    await engine.startRun(workflowId, {})
    await engine.idle()
    clock.jump(1000)
    await engine.startRun(workflowId, {})
    await engine.idle()
    const entries = engine.listHookLog({ limit: 200 })
    expect(entries).toHaveLength(6)
    for (const entry of entries) {
      expect(Value.Check(HookLogEntrySchema, entry)).toBe(true)
      if (entry.code !== null) expect(HOOK_FAILURE_CODES as readonly string[]).toContain(entry.code)
      if (entry.outcome !== 'failed') expect(entry.code).toBeNull()
    }
    const text = JSON.stringify(entries)
    for (const leak of ['Secret Workflow Name', 'team-slack', 'hook-slack', '#bad', 'channel_not_found', BOT_TOKEN, 'HOOKWEBHOOKMARKER']) expect(text, leak).not.toContain(leak)
  })

  it('carry the time of the event and the id of the workflow that the run belongs to', async () => {
    stubSlack()
    const { engine, db, clock } = setup()
    const workflowId = engine.deploy(failingWorkflow('w'))
    engine.saveHook(hookInput())
    clock.jump(12_345)
    await engine.startRun(workflowId, {})
    await engine.idle()
    expect(logRows(db)[0]).toMatchObject({ at: START + 12_345, workflow_id: workflowId, event: 'run.failed' })
  })

  it('are written nowhere when the run record is gone', async () => {
    stubSlack()
    const { runner, store, db } = standalone()
    store.saveHook({ event: 'run.failed', scope: { type: 'all' }, action: { type: 'record' }, enabled: true })
    runner.handle(finished('no-such-run', 'failed', START))
    await runner.idle()
    expect(logRows(db)).toEqual([])
  })
})

function tables(db: Db): Record<'runs' | 'plans' | 'workflows' | 'step_attempts', number> {
  const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
  return { runs: count('runs'), plans: count('plans'), workflows: count('workflows'), step_attempts: count('step_attempts') }
}
