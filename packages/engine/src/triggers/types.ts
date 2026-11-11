import type { Clock } from '../clock'
import type { EngineEventInput } from '../events'
import type { Store } from '../store'

export interface FireOptions {
  fingerprint?: { value: string; path: string }
}

export interface TriggerHost {
  readonly store: Store
  readonly clock: Clock
  fire(workflowId: string, payload: unknown, options?: FireOptions): { runId: string }
  isBusy(workflowId: string): boolean
  emit(event: EngineEventInput): void
}

export interface TriggerRuntime {
  stop(): void
  idle?(): Promise<void>
}
