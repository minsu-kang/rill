import { act } from '@testing-library/react'

export async function frames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

export interface Gate<T = void> {
  promise: Promise<T>
  open(value: T): Promise<void>
  refuse(error: unknown): Promise<void>
}

export function gate<T = void>(): Gate<T> {
  let resolveGate: (value: T) => void = () => undefined
  let rejectGate: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveGate = resolve
    rejectGate = reject
  })
  return {
    promise,
    open: (value) =>
      act(async () => {
        resolveGate(value)
      }),
    refuse: (error) =>
      act(async () => {
        rejectGate(error)
      }),
  }
}
