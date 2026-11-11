import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathNotAllowedError'
  }
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function resolveReal(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (exists(current)) throw new PathNotAllowedError(`path is a dangling symlink: ${path}`)
      const parent = dirname(current)
      if (parent === current) throw error
      missing.unshift(basename(current))
      current = parent
    }
  }
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes('..')
}

export function assertPathAllowed(path: string, roots: string[] | undefined): string {
  const expanded = expandHome(path)
  if (roots === undefined) return expanded
  if (!isAbsolute(expanded)) throw new PathNotAllowedError(`path must be absolute or start with ~/: ${path}`)
  if (hasParentSegment(expanded)) throw new PathNotAllowedError(`path must not contain '..': ${path}`)
  const target = resolveReal(expanded)
  if (!roots.some((root) => isInside(resolveReal(expandHome(root)), target))) {
    throw new PathNotAllowedError(`path is outside the allowed folders: ${path}`)
  }
  return expanded
}
