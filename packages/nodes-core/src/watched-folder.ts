import { basename, dirname, resolve } from 'node:path'
import type { PlanIssue, Workflow } from '@rill/dsl'
import { expandHome } from './guard'
import type { NodeRegistry } from './registry'
import { fieldRoles, isWriteField, valueAtPointer } from './roles'

const IGNORED = [/^\./, /^~\$/, /~$/, /\.(tmp|part|crdownload|download)$/i]
const FOLDER_WATCH = 'trigger.folderWatch'

export const WATCHED_FOLDER_CODE = 'inside_watched_folder'

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

function baseType(type: string): string {
  return type.replace(/@\d+$/, '')
}

function folderKey(path: string): string {
  return resolve(expandHome(path)).normalize('NFC').toLowerCase()
}

export function watchedFolderIssues(workflow: Workflow, registry: NodeRegistry): PlanIssue[] {
  const watches = workflow.nodes.flatMap((node) => {
    const config = node.config as { folder?: unknown; glob?: unknown }
    if (baseType(node.type) !== FOLDER_WATCH || typeof config.folder !== 'string') return []
    return [{ folder: folderKey(config.folder), matches: globToRegExp(typeof config.glob === 'string' ? config.glob : '*') }]
  })
  const issues: PlanIssue[] = []
  workflow.nodes.forEach((node, index) => {
    const def = registry.get(node.type)
    if (def === undefined) return
    for (const { pointer } of fieldRoles(def)) {
      const value = valueAtPointer(node.config, pointer)
      if (!isWriteField(def, pointer) || typeof value !== 'string') continue
      const file = resolve(expandHome(value))
      if (!watches.some((watch) => folderKey(dirname(file)) === watch.folder && folderWatchSees(watch.matches, basename(file)))) continue
      issues.push({
        stage: 3,
        pointer: `/nodes/${index}/config${pointer}`,
        code: WATCHED_FOLDER_CODE,
        message: `node ${node.id}: the file is in the watched folder and the pattern matches it, so each write would start the workflow again; write it to another folder or change the pattern`,
      })
    }
  })
  return issues
}
