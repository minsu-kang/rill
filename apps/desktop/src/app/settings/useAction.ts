import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../../i18n'
import { useKeepFocus } from '../../ui/useKeepFocus'
import { hostErrorKey } from './errors'

export interface ActionState {
  busy: boolean
  error: MessageKey | undefined
  run(work: () => Promise<void>): Promise<boolean>
  clearError(): void
}

export function useAction(mapError: (error: unknown) => MessageKey = hostErrorKey): ActionState {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<MessageKey | undefined>(undefined)
  const running = useRef(false)
  const alive = useRef(true)

  useKeepFocus(busy)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    async (work: () => Promise<void>): Promise<boolean> => {
      if (running.current) return false
      running.current = true
      setBusy(true)
      setError(undefined)
      try {
        await work()
        return true
      } catch (failure) {
        if (alive.current) setError(mapError(failure))
        return false
      } finally {
        running.current = false
        if (alive.current) setBusy(false)
      }
    },
    [mapError],
  )

  const clearError = useCallback(() => setError(undefined), [])
  return { busy, error, run, clearError }
}
