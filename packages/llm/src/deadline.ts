export const MAX_TIMER_MS = 2_147_483_647

export interface Deadline {
  signal: AbortSignal
  expired(): boolean
  dispose(): void
}

export function startDeadline(ms: number, caller: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  let expired = false
  const onCallerAbort = () => controller.abort(caller?.reason)
  const timer = setTimeout(
    () => {
      if (controller.signal.aborted) return
      expired = true
      controller.abort()
    },
    ms > 0 ? Math.min(ms, MAX_TIMER_MS) : MAX_TIMER_MS,
  )
  if (caller?.aborted) onCallerAbort()
  else caller?.addEventListener('abort', onCallerAbort, { once: true })
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}
