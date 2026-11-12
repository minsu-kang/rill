import { useCallback, useEffect, useRef, type RefObject } from 'react'

export interface StepFocusOptions {
  scope?: string | undefined
  container?: RefObject<HTMLElement | null>
  initial?: boolean
}

interface Seen {
  step: string
  scope: string | undefined
}

export function useStepFocus(step: string, { scope, container, initial = false }: StepFocusOptions = {}): (node: HTMLElement | null) => void {
  const anchor = useRef<HTMLElement | null>(null)
  const seen = useRef<Seen | null>(null)
  const attach = useCallback((node: HTMLElement | null) => {
    anchor.current = node
  }, [])

  useEffect(() => {
    const before = seen.current
    seen.current = { step, scope }
    if (before === null ? !initial : before.step === step || before.scope !== scope) return
    const active = document.activeElement
    const lost = active === null || active === document.body
    if (lost || (active !== null && container?.current?.contains(active) === true)) anchor.current?.focus()
  }, [step, scope, initial, container])

  return attach
}
