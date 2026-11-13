import { useEffect, useRef } from 'react'
import { canRestoreFocus } from './focusRestore'

let watchers = 0
let lastFocused: HTMLElement | null = null

function remember(event: FocusEvent): void {
  const { target } = event
  if (target instanceof HTMLElement && target !== document.body) lastFocused = target
}

function forget(event: FocusEvent): void {
  const { target } = event
  if (target !== lastFocused || event.relatedTarget !== null) return
  if (target instanceof HTMLElement && target.isConnected && !target.matches(':disabled')) lastFocused = null
}

function watch(): () => void {
  if (watchers === 0) {
    const { activeElement } = document
    lastFocused = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null
    document.addEventListener('focusin', remember)
    document.addEventListener('focusout', forget)
  }
  watchers += 1
  return () => {
    watchers -= 1
    if (watchers > 0) return
    document.removeEventListener('focusin', remember)
    document.removeEventListener('focusout', forget)
    lastFocused = null
  }
}

function focusQuietly(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true })
  } catch {
    return
  }
}

export function useKeepFocus(busy: boolean): void {
  const held = useRef<HTMLElement | null>(null)
  const idle = useRef(false)

  useEffect(() => watch(), [])

  useEffect(() => {
    if (busy) {
      held.current = idle.current && lastFocused !== null && lastFocused.isConnected ? lastFocused : null
      return
    }
    idle.current = true
    const element = held.current
    held.current = null
    if (canRestoreFocus(element, document.activeElement)) focusQuietly(element)
  }, [busy])
}
