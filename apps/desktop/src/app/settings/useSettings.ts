import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostApi, Settings } from '../../shared/host-api'

export interface SettingsState {
  settings: Settings | undefined
  failed: boolean
  reload(): Promise<void>
  apply(next: Settings): void
}

export function useSettings(host: HostApi): SettingsState {
  const [settings, setSettings] = useState<Settings | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await host.settings.get()
      if (!alive.current) return
      setSettings(next)
      setFailed(false)
    } catch {
      if (alive.current) setFailed(true)
    }
  }, [host])

  useEffect(() => {
    let current = true
    host.settings.get().then(
      (next) => {
        if (!current) return
        setSettings(next)
        setFailed(false)
      },
      () => {
        if (current) setFailed(true)
      },
    )
    return () => {
      current = false
    }
  }, [host])

  const apply = useCallback((next: Settings) => setSettings(next), [])
  return { settings, failed, reload, apply }
}
