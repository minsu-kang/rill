export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => {
      clearTimeout(timer)
    }
  },
}
