import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { assertPathAllowed, type FolderWatchConfig } from '@rill/nodes-core'
import { DuplicateFileError } from '../store'
import type { TriggerHost, TriggerRuntime } from './types'

const IGNORED = [/^\./, /^~\$/, /~$/, /\.(tmp|part|crdownload|download)$/i]

export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (const char of glob.normalize('NFC')) {
    if (char === '*') source += '[^/\\\\]*'
    else if (char === '?') source += '[^/\\\\]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

export function folderWatchSees(matches: RegExp, name: string): boolean {
  return matches.test(name.normalize('NFC')) && !IGNORED.some((pattern) => pattern.test(name))
}

function fingerprintOf(path: string, mtimeMs: number, size: number): string {
  return createHash('sha256').update(`${path}\0${mtimeMs}\0${size}`).digest('hex')
}

interface Observation {
  size: number
  mtimeMs: number
  stableSince: number
  done: boolean
  reported: boolean
}

export class FolderRuntime implements TriggerRuntime {
  private readonly workflowId: string
  private readonly host: TriggerHost
  private readonly folder: string
  private readonly matches: RegExp
  private readonly pollMs: number
  private readonly stableMs: number
  private readonly includeExisting: boolean
  private readonly observed = new Map<string, Observation>()
  private cancel: (() => void) | undefined
  private stopped = false

  constructor(workflowId: string, config: FolderWatchConfig, host: TriggerHost, allowedRoots: string[] | undefined) {
    this.workflowId = workflowId
    this.host = host
    this.folder = assertPathAllowed(config.folder, allowedRoots)
    let isDirectory: boolean
    try {
      isDirectory = statSync(this.folder).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) throw new Error(`folder does not exist: ${config.folder}`)
    this.matches = globToRegExp(config.glob ?? '*')
    this.pollMs = config.pollMs ?? 1000
    this.stableMs = config.stableMs ?? 2000
    this.includeExisting = config.includeExisting ?? false
  }

  start(): void {
    if (this.host.store.getTriggerState(this.workflowId) === undefined) {
      if (!this.includeExisting) this.recordExistingAsSeen()
      this.host.store.saveTriggerState(this.workflowId, { nextFireAt: null, lastFireAt: null })
    }
    this.arm()
  }

  stop(): void {
    this.stopped = true
    this.cancel?.()
    this.cancel = undefined
  }

  scanOnce(): void {
    if (this.stopped) return
    let names: string[]
    try {
      names = this.listCandidates()
    } catch (error) {
      this.report(error)
      return
    }
    const now = this.host.clock.now()
    const present = new Set<string>()
    for (const name of names) {
      const path = join(this.folder, name)
      present.add(path)
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      let entry = this.observed.get(path)
      if (!entry || entry.size !== stats.size || entry.mtimeMs !== stats.mtimeMs) {
        entry = { size: stats.size, mtimeMs: stats.mtimeMs, stableSince: now, done: false, reported: false }
        this.observed.set(path, entry)
      }
      if (entry.done || now - entry.stableSince < this.stableMs) continue
      const fingerprint = fingerprintOf(path, stats.mtimeMs, stats.size)
      if (this.host.store.hasSeenFile(this.workflowId, fingerprint)) {
        entry.done = true
        continue
      }
      try {
        this.host.fire(
          this.workflowId,
          {
            file: path,
            name,
            extension: extname(name).toLowerCase(),
            bytes: stats.size,
            modifiedAt: new Date(stats.mtimeMs).toISOString(),
          },
          { fingerprint: { value: fingerprint, path } },
        )
        entry.done = true
      } catch (error) {
        if (error instanceof DuplicateFileError) entry.done = true
        else if (!entry.reported) {
          entry.reported = true
          this.report(error)
        }
      }
    }
    for (const path of [...this.observed.keys()]) {
      if (!present.has(path)) this.observed.delete(path)
    }
  }

  private arm(): void {
    if (this.stopped) return
    this.cancel = this.host.clock.setTimeout(() => {
      this.scanOnce()
      this.arm()
    }, this.pollMs)
  }

  private listCandidates(): string[] {
    return readdirSync(this.folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => folderWatchSees(this.matches, name))
  }

  private recordExistingAsSeen(): void {
    for (const name of this.listCandidates()) {
      const path = join(this.folder, name)
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      this.host.store.markFileSeen(this.workflowId, fingerprintOf(path, stats.mtimeMs, stats.size), path, null)
    }
  }

  private report(error: unknown): void {
    this.host.emit({
      type: 'trigger.error',
      workflowId: this.workflowId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
