export class RunQueue {
  private readonly limit: number
  private readonly waitingJobs: Array<() => void> = []
  private running = 0
  private idleResolvers: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    this.limit = limit
  }

  get active(): number {
    return this.running
  }

  get waiting(): number {
    return this.waitingJobs.length
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.running += 1
        let pending: Promise<T>
        try {
          pending = job()
        } catch (error) {
          this.finish()
          reject(error)
          return
        }
        pending.then(
          (value) => {
            this.finish()
            resolve(value)
          },
          (error: unknown) => {
            this.finish()
            reject(error)
          },
        )
      }
      if (this.running < this.limit) start()
      else this.waitingJobs.push(start)
    })
  }

  idle(): Promise<void> {
    if (this.running === 0 && this.waitingJobs.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  private finish(): void {
    this.running -= 1
    const next = this.waitingJobs.shift()
    if (next) {
      next()
      return
    }
    if (this.running === 0) {
      const resolvers = this.idleResolvers
      this.idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }
}
