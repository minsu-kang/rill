import type { Clock } from '../src/clock'

interface Timer {
  at: number
  fn: () => void
}

export class ManualClock implements Clock {
  private current: number
  private nextId = 1
  private readonly timers = new Map<number, Timer>()

  constructor(start: number) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn })
    return () => {
      this.timers.delete(id)
    }
  }

  get pending(): number {
    return this.timers.size
  }

  jump(ms: number): void {
    this.current += ms
  }

  sleep(ms: number): void {
    this.current += ms
    for (const timer of this.timers.values()) timer.at += ms
  }

  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      const due = this.firstDue(target)
      if (!due) break
      this.timers.delete(due[0])
      this.current = Math.max(this.current, due[1].at)
      due[1].fn()
    }
    this.current = target
  }

  fireDue(): void {
    for (;;) {
      const due = this.firstDue(this.current)
      if (!due) break
      this.timers.delete(due[0])
      due[1].fn()
    }
  }

  private firstDue(limit: number): [number, Timer] | undefined {
    return [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= limit)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
  }
}
