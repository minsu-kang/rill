import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const APP_SCHEME = 'app'
export const APP_HOST = 'rill'
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`
export const APP_SCHEME_PRIVILEGES = { standard: true, secure: true } as const

export interface AppRequestLike {
  url: string
  method: string
}

export function resolveAppFile(url: string, root: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return undefined
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return undefined
  }
  if (path.includes('\u0000') || path.includes('\\')) return undefined
  const segments = path.split('/').slice(1)
  if (segments.some((segment) => segment === '..' || segment === '.')) return undefined
  const file = join(root, path === '/' ? 'index.html' : path)
  const inside = relative(root, file)
  return inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside) ? undefined : file
}

export function createAppProtocolHandler(deps: { root: string; fetchFile: (fileUrl: string) => Promise<Response> }): (request: AppRequestLike) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const file = resolveAppFile(request.url, deps.root)
    if (file === undefined) return new Response(null, { status: 404 })
    try {
      return await deps.fetchFile(pathToFileURL(file).href)
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}
