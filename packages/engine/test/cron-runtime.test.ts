import { CronParseError } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { CATCH_UP_GRACE_MS, CronRuntime } from '../src/triggers/cron'
import { ManualClock } from './manual-clock'
import { createHost } from './trigger-helpers'

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 11, h, m, s)
const iso = (ms: number) => new Date(ms).toISOString()

describe('CronRuntime', () => {
  it('fires at each scheduled minute with the schedule in the payload', () => {
    const clock = new ManualClock(at(10, 2, 30))
    const h = createHost(clock)
    const runtime = new CronRuntime(h.workflowId, { expression: '*/5 * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    clock.advance(150_000)
    expect(h.fired.map((f) => f.payload)).toEqual([{ scheduledFor: iso(at(10, 5)), firedAt: iso(at(10, 5)) }])
    clock.advance(300_000)
    expect(h.fired).toHaveLength(2)
    expect(h.fired[1]?.payload).toEqual({ scheduledFor: iso(at(10, 10)), firedAt: iso(at(10, 10)) })
    runtime.stop()
  })

  it('persists the next and last fire times', () => {
    const clock = new ManualClock(at(10, 2, 30))
    const h = createHost(clock)
    const runtime = new CronRuntime(h.workflowId, { expression: '*/5 * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    expect(h.store.getTriggerState(h.workflowId)).toEqual({ nextFireAt: at(10, 5), lastFireAt: null })
    clock.advance(150_000)
    expect(h.store.getTriggerState(h.workflowId)).toEqual({ nextFireAt: at(10, 10), lastFireAt: at(10, 5) })
    runtime.stop()
  })

  it('drops a long-missed schedule by default and reschedules', () => {
    const clock = new ManualClock(at(12, 0, 10))
    const h = createHost(clock)
    h.store.saveTriggerState(h.workflowId, { nextFireAt: at(9, 0), lastFireAt: null })
    const runtime = new CronRuntime(h.workflowId, { expression: '0 * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    expect(h.fired).toHaveLength(0)
    expect(h.events).toEqual([{ type: 'trigger.skipped', workflowId: h.workflowId, reason: 'missed schedule' }])
    expect(h.store.getTriggerState(h.workflowId)?.nextFireAt).toBe(at(13, 0))
    runtime.stop()
  })

  it('runs a long-missed schedule once with catchUp once', () => {
    const clock = new ManualClock(at(12, 0, 10))
    const h = createHost(clock)
    h.store.saveTriggerState(h.workflowId, { nextFireAt: at(9, 0), lastFireAt: null })
    const runtime = new CronRuntime(
      h.workflowId,
      { expression: '0 * * * *', timezone: 'utc', catchUp: 'once' },
      h.host,
    )
    runtime.start()
    expect(h.fired.map((f) => f.payload)).toEqual([{ scheduledFor: iso(at(9, 0)), firedAt: iso(at(12, 0, 10)) }])
    expect(h.store.getTriggerState(h.workflowId)?.nextFireAt).toBe(at(13, 0))
    runtime.stop()
  })

  it('still fires a schedule that is only slightly late', () => {
    const clock = new ManualClock(at(12, 0, 10))
    const h = createHost(clock)
    h.store.saveTriggerState(h.workflowId, { nextFireAt: at(12, 0), lastFireAt: null })
    const runtime = new CronRuntime(h.workflowId, { expression: '0 * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    expect(h.fired).toHaveLength(1)
    expect(CATCH_UP_GRACE_MS).toBe(60_000)
    runtime.stop()
  })

  it('collapses many missed minutes into one decision after the clock jumps', () => {
    const clock = new ManualClock(at(10, 0, 30))
    const skipping = createHost(clock)
    const a = new CronRuntime(skipping.workflowId, { expression: '* * * * *', timezone: 'utc' }, skipping.host)
    a.start()
    const once = createHost(clock)
    const b = new CronRuntime(once.workflowId, { expression: '* * * * *', timezone: 'utc', catchUp: 'once' }, once.host)
    b.start()
    clock.jump(10 * 60_000)
    clock.fireDue()
    expect(skipping.fired).toHaveLength(0)
    expect(once.fired).toHaveLength(1)
    expect(once.fired[0]?.payload).toEqual({ scheduledFor: iso(at(10, 1)), firedAt: iso(at(10, 10, 30)) })
    expect(skipping.store.getTriggerState(skipping.workflowId)?.nextFireAt).toBe(at(10, 11))
    a.stop()
    b.stop()
  })

  it('skips a tick while the previous run is active, and queues it with overlap queue', () => {
    const clock = new ManualClock(at(10, 0, 30))
    const h = createHost(clock)
    const skipping = new CronRuntime(h.workflowId, { expression: '* * * * *', timezone: 'utc' }, h.host)
    skipping.start()
    h.setBusy(true)
    clock.advance(30_000)
    expect(h.fired).toHaveLength(0)
    expect(h.events).toEqual([
      { type: 'trigger.skipped', workflowId: h.workflowId, reason: 'previous run is still active' },
    ])
    skipping.stop()

    const clock2 = new ManualClock(at(10, 0, 30))
    const h2 = createHost(clock2)
    const queueing = new CronRuntime(h2.workflowId, { expression: '* * * * *', timezone: 'utc', overlap: 'queue' }, h2.host)
    queueing.start()
    h2.setBusy(true)
    clock2.advance(30_000)
    expect(h2.fired).toHaveLength(1)
    queueing.stop()
  })

  it('reports a failing fire and keeps its schedule', () => {
    const clock = new ManualClock(at(10, 0, 30))
    const h = createHost(clock)
    const runtime = new CronRuntime(h.workflowId, { expression: '* * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    h.failFires(true)
    clock.advance(30_000)
    expect(h.events).toEqual([{ type: 'trigger.error', workflowId: h.workflowId, error: 'fire failed' }])
    h.failFires(false)
    clock.advance(60_000)
    expect(h.fired).toHaveLength(1)
    runtime.stop()
  })

  it('wakes at least every 30 seconds so it notices the time after a sleep', () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 10, 18, 0, 0))
    const h = createHost(clock)
    const runtime = new CronRuntime(h.workflowId, { expression: '0 9 * * *', timezone: 'utc' }, h.host)
    runtime.start()
    clock.advance(15 * 3_600_000)
    const nine = Date.UTC(2026, 10, 11, 9)
    expect(h.fired.map((f) => f.payload)).toEqual([{ scheduledFor: iso(nine), firedAt: iso(nine) }])
    runtime.stop()
  })

  it('notices a schedule that came due while the machine slept, because timers do not count sleep', () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 10, 18, 0, 0))
    const h = createHost(clock)
    const runtime = new CronRuntime(h.workflowId, { expression: '0 9 * * *', timezone: 'utc' }, h.host)
    runtime.start()
    clock.advance(8 * 3_600_000)
    clock.sleep(5 * 3_600_000)
    clock.advance(2 * 3_600_000)
    const nine = Date.UTC(2026, 10, 11, 9)
    expect(h.fired).toHaveLength(1)
    const payload = h.fired[0]!.payload as { scheduledFor: string; firedAt: string }
    expect(payload.scheduledFor).toBe(iso(nine))
    expect(Date.parse(payload.firedAt) - nine).toBeLessThan(30_000)
    runtime.stop()
  })

  it('does not trust a saved fire time that is later than the schedule allows', () => {
    const clock = new ManualClock(at(10, 0, 30))
    const h = createHost(clock)
    h.store.saveTriggerState(h.workflowId, { nextFireAt: at(10, 0, 30) + 365 * 86_400_000, lastFireAt: null })
    const runtime = new CronRuntime(h.workflowId, { expression: '* * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    expect(h.store.getTriggerState(h.workflowId)?.nextFireAt).toBe(at(10, 1))
    clock.advance(60_000)
    expect(h.fired).toHaveLength(1)
    runtime.stop()
  })

  it('stops cleanly: no timer is left and nothing fires afterwards', () => {
    const clock = new ManualClock(at(10, 0, 30))
    const h = createHost(clock)
    const runtime = new CronRuntime(h.workflowId, { expression: '* * * * *', timezone: 'utc' }, h.host)
    runtime.start()
    expect(clock.pending).toBe(1)
    runtime.stop()
    expect(clock.pending).toBe(0)
    clock.advance(5 * 60_000)
    expect(h.fired).toHaveLength(0)
  })

  it('rejects an invalid expression when constructed', () => {
    const h = createHost(new ManualClock(0))
    expect(() => new CronRuntime(h.workflowId, { expression: 'nope' }, h.host)).toThrow(CronParseError)
  })
})
