import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'

export type SqlParam = string | number | bigint | null | Uint8Array

export class Db {
  private readonly raw: DatabaseSync

  private constructor(raw: DatabaseSync) {
    this.raw = raw
  }

  static open(path: string): Db {
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const db = new Db(raw)
    migrate(db)
    return db
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  run(sql: string, ...params: SqlParam[]): number {
    return Number(this.raw.prepare(sql).run(...params).changes)
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[]
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.raw.close()
  }
}
