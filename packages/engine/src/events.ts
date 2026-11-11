export type EngineEvent =
  | { type: 'run.started'; at: number; runId: string; workflowId: string; dryRun: boolean }
  | { type: 'step.started'; at: number; runId: string; nodeId: string; attempt: number }
  | { type: 'step.succeeded'; at: number; runId: string; nodeId: string; attempt: number }
  | {
      type: 'step.failed'
      at: number
      runId: string
      nodeId: string
      attempt: number
      error: string
      willRetry: boolean
    }
  | { type: 'step.skipped'; at: number; runId: string; nodeId: string }
  | { type: 'step.continued'; at: number; runId: string; nodeId: string; attempt: number; error: string }
  | { type: 'run.finished'; at: number; runId: string; status: 'succeeded' | 'failed'; error: string | null }
  | { type: 'trigger.fired'; at: number; workflowId: string; runId: string }
  | { type: 'trigger.skipped'; at: number; workflowId: string; reason: string }
  | { type: 'trigger.error'; at: number; workflowId: string; error: string }
  | { type: 'workflow.activated'; at: number; workflowId: string }
  | { type: 'workflow.deactivated'; at: number; workflowId: string }

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
