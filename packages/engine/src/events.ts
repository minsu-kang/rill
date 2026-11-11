import type { EngineEvent } from '@rill/protocol'

export type { EngineEvent }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type EngineEventInput = DistributiveOmit<EngineEvent, 'at'>

export type EngineListener = (event: EngineEvent) => void

export class EventBus {
  private readonly listeners = new Set<EngineListener>()
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: EngineEventInput): void {
    const stamped = { ...event, at: this.now() } as EngineEvent
    for (const listener of [...this.listeners]) {
      try {
        listener(stamped)
      } catch {
        continue
      }
    }
  }
}
