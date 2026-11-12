import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { PlanIssue, Workflow } from '@rill/dsl'
import { expandHome, resolveReal } from './guard'
import type { NodeRegistry } from './registry'
import { fieldRoles, isWriteField, valueAtPointer } from './roles'

const IGNORED = [/^\./, /^~\$/, /~$/, /\.(tmp|part|crdownload|download)$/i]
const FOLDER_WATCH = 'trigger.folderWatch'
const TRIGGER_FILE = /^\{\{\s*([a-z][a-z0-9_]*)\.output\.file\s*\}\}/
const SEPARATOR = /[\\/]/

export const WATCHED_FOLDER_CODE = 'inside_watched_folder'
export const WATCHED_FOLDER_HINT = 'write the file to another folder or narrow the trigger pattern'

export interface GlobMatcher {
  test(name: string): boolean
}

type GlobItem = { kind: 'star' } | { kind: 'any' } | { kind: 'unit'; unit: string }

function isSeparator(unit: string | undefined): boolean {
  return unit === '/' || unit === '\\'
}

function canonical(unit: string): string {
  const upper = unit.toUpperCase()
  if (upper.length !== 1) return unit
  if (unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) return unit
  return upper
}

export function compileGlob(glob: string): GlobMatcher {
  const items: GlobItem[] = []
  for (const char of glob.normalize('NFC')) {
    if (char === '*') items.push({ kind: 'star' })
    else if (char === '?') items.push({ kind: 'any' })
    else {
      for (let index = 0; index < char.length; index += 1) items.push({ kind: 'unit', unit: canonical(char[index] as string) })
    }
  }
  return {
    test(name: string): boolean {
      let item = 0
      let at = 0
      let starItem = -1
      let starAt = 0
      while (at < name.length) {
        const current = items[item]
        if (current?.kind === 'star') {
          starItem = item
          starAt = at
          item += 1
        } else if (current !== undefined && (current.kind === 'any' ? !isSeparator(name[at]) : canonical(name[at] as string) === current.unit)) {
          item += 1
          at += 1
        } else if (starItem >= 0 && !isSeparator(name[starAt])) {
          starAt += 1
          at = starAt
          item = starItem + 1
        } else return false
      }
      while (items[item]?.kind === 'star') item += 1
      return item === items.length
    },
  }
}

export function folderWatchSees(matches: GlobMatcher, name: string): boolean {
  return matches.test(name.normalize('NFC')) && !IGNORED.some((pattern) => pattern.test(name))
}

function baseType(type: string): string {
  return type.replace(/@\d+$/, '')
}

function foldKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function folderKeys(path: string): string[] {
  const keys = [foldKey(resolve(expandHome(path)))]
  try {
    keys.push(foldKey(resolveReal(expandHome(path))))
  } catch {
    return keys
  }
  return keys
}

interface Watch {
  id: string
  keys: string[]
  matches: GlobMatcher
}

function writesIntoWatch(watch: Watch, value: string): boolean {
  const lead = TRIGGER_FILE.exec(value)
  if (lead !== null) {
    if (lead[1] !== watch.id) return false
    const rest = value.slice(lead[0].length)
    return rest === '' || (!SEPARATOR.test(rest) && folderWatchSees(watch.matches, `x${rest}`))
  }
  const expanded = expandHome(value)
  if (value.includes('{{') && !isAbsolute(expanded)) return false
  const file = resolve(expanded)
  return folderKeys(dirname(file)).some((key) => watch.keys.includes(key)) && folderWatchSees(watch.matches, basename(file))
}

export function watchedFolderIssues(workflow: Workflow, registry: NodeRegistry): PlanIssue[] {
  const watches = workflow.nodes.flatMap((node): Watch[] => {
    const config = node.config as { folder?: unknown; glob?: unknown }
    if (baseType(node.type) !== FOLDER_WATCH || typeof config.folder !== 'string') return []
    return [{ id: node.id, keys: folderKeys(config.folder), matches: compileGlob(typeof config.glob === 'string' ? config.glob : '*') }]
  })
  const issues: PlanIssue[] = []
  workflow.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    if (def === undefined) return
    for (const { pointer } of fieldRoles(def)) {
      const value = valueAtPointer(node.config, pointer)
      if (!isWriteField(def, pointer) || typeof value !== 'string' || !watches.some((watch) => writesIntoWatch(watch, value))) continue
      issues.push({
        stage: 3,
        pointer: `/nodes/${index}/config${pointer}`,
        code: WATCHED_FOLDER_CODE,
        message: `node ${node.id}: the file is in the watched folder and the pattern matches it, so each write would start the workflow again`,
        hint: WATCHED_FOLDER_HINT,
      })
    }
  })
  return issues
}
