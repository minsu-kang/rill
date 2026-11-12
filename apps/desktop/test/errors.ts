import { vi } from 'vitest'

export function errorsDuring(action: () => void): string[] {
  const seen: string[] = []
  const listener = (event: ErrorEvent): void => {
    seen.push(String(event.message))
    event.preventDefault()
  }
  window.addEventListener('error', listener)
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    seen.push(String(args[0]).slice(0, 200))
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    seen.push(String(args[0]).slice(0, 200))
  })
  try {
    action()
  } finally {
    window.removeEventListener('error', listener)
    spy.mockRestore()
    warn.mockRestore()
  }
  return seen
}
