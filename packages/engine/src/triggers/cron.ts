import { nextCronTime, parseCron, type CronSpec, type CronTriggerConfig, type CronZone } from '@rill/nodes-core'
import type { TriggerHost, TriggerRuntime } from './types'

export const CATCH_UP_GRACE_MS = 60_000
const MAX_TIMER_MS = 30_000

export class CronRuntime implements TriggerRuntime {
  private readonly workflowId: string
  private readonly config: CronTriggerConfig
  private readonly host: TriggerHost
  private readonly spec: CronSpec
  private nextFireAt: number | null = null
  private lastFireAt: number | null = null
  private cancel: (() => void) | undefined
  private stopped = false

  constructor(workflowId: string, config: CronTriggerConfig, host: TriggerHost) {
    this.workflowId = workflowId
    this.config = config
    this.host = host
    this.spec = parseCron(config.expression)
  }

  start(): void {
    const state = this.host.store.getTriggerState(this.workflowId)
    this.lastFireAt = state?.lastFireAt ?? null
    const computed = nextCronTime(this.spec, this.host.clock.now(), this.zone())
    const saved = state?.nextFireAt ?? null
    this.nextFireAt = saved === null ? computed : computed === null ? saved : Math.min(saved, computed)
    this.persist()
    this.evaluate()
  }

  stop(): void {
    this.stopped = true
    this.cancel?.()
    this.cancel = undefined
  }

  private zone(): CronZone {
    return this.config.timezone ?? 'local'
  }

  private persist(): void {
    this.host.store.saveTriggerState(this.workflowId, { nextFireAt: this.nextFireAt, lastFireAt: this.lastFireAt })
  }

  private evaluate(): void {
    if (this.stopped) return
    const now = this.host.clock.now()
    if (this.nextFireAt !== null && this.nextFireAt <= now) {
      const scheduledFor = this.nextFireAt
      this.nextFireAt = nextCronTime(this.spec, now, this.zone())
      if (now - scheduledFor <= CATCH_UP_GRACE_MS || this.config.catchUp === 'once') {
        this.fire(scheduledFor, now)
      } else {
        this.host.emit({ type: 'trigger.skipped', workflowId: this.workflowId, reason: 'missed schedule' })
      }
      this.persist()
    }
    this.arm()
  }

  private arm(): void {
    if (this.nextFireAt === null) return
    const delay = Math.min(Math.max(0, this.nextFireAt - this.host.clock.now()), MAX_TIMER_MS)
    this.cancel = this.host.clock.setTimeout(() => this.evaluate(), delay)
  }

  private fire(scheduledFor: number, now: number): void {
    if ((this.config.overlap ?? 'skip') === 'skip' && this.host.isBusy(this.workflowId)) {
      this.host.emit({ type: 'trigger.skipped', workflowId: this.workflowId, reason: 'previous run is still active' })
      return
    }
    try {
      this.host.fire(this.workflowId, {
        scheduledFor: new Date(scheduledFor).toISOString(),
        firedAt: new Date(now).toISOString(),
      })
      this.lastFireAt = now
    } catch (error) {
      this.host.emit({
        type: 'trigger.error',
        workflowId: this.workflowId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
