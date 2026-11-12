// @vitest-environment node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { APP_INDEX_URL, APP_SCHEME_PRIVILEGES, createAppProtocolHandler, resolveAppFile } from '../src/main/app-protocol'

const ROOT = '/app/dist/renderer'

describe('app protocol: which file a url means', () => {
  it('maps the index and assets below the root', () => {
    expect(resolveAppFile('app://rill/index.html', ROOT)).toBe(join(ROOT, 'index.html'))
    expect(resolveAppFile('app://rill/', ROOT)).toBe(join(ROOT, 'index.html'))
    expect(resolveAppFile('app://rill/assets/index-abc123.js', ROOT)).toBe(join(ROOT, 'assets', 'index-abc123.js'))
    expect(resolveAppFile('app://rill/assets/index.css?x=1#y', ROOT)).toBe(join(ROOT, 'assets', 'index.css'))
  })

  it.each([
    ['app://rill/../secrets.bin', 'secrets.bin'],
    ['app://rill/assets/../../main/index.mjs', 'main/index.mjs'],
    ['app://rill/%2e%2e/main/index.mjs', 'main/index.mjs'],
    ['app://rill/assets/%2E%2E/%2e%2e/main/index.mjs', 'main/index.mjs'],
    ['app://rill/assets/./x.js', 'assets/x.js'],
  ])('turns the dot segments of %s into a file below the root', (url, file) => {
    expect(resolveAppFile(url, ROOT)).toBe(join(ROOT, file))
  })

  it.each([
    ['app://rill/..%2fmain/index.mjs'],
    ['app://rill/assets%5c..%5cindex.js'],
    ['app://rill/a\\b'],
    ['app://rill/a%00b'],
    ['app://rill/%2e%2e%2fmain/index.mjs'],
    ['app://rill/assets/%2e%2e/%2e%2e%2fmain'],
    ['app://rill/assets%2f..%2f..%2fmain'],
    ['app://rill/%zz'],
    ['app://other/index.html'],
    ['app://user@rill/index.html'],
    ['app://rill:8080/index.html'],
    ['file:///app/dist/renderer/index.html'],
    ['http://rill/index.html'],
    ['not a url'],
    [''],
  ])('refuses %s', (url) => {
    expect(resolveAppFile(url, ROOT)).toBeUndefined()
  })

  it('keeps the index address and the privileges the window needs, and nothing more', () => {
    expect(APP_INDEX_URL).toBe('app://rill/index.html')
    expect(APP_SCHEME_PRIVILEGES).toEqual({ standard: true, secure: true })
  })
})

describe('app protocol: the handler', () => {
  function handler(fetchFile = vi.fn(async (url: string) => new Response(`file:${url}`, { status: 200 }))) {
    return { fetchFile, handle: createAppProtocolHandler({ root: ROOT, fetchFile }) }
  }

  it('serves a file of the root through the file fetcher', async () => {
    const { handle, fetchFile } = handler()
    const response = await handle({ url: 'app://rill/assets/a.js', method: 'GET' })
    expect(response.status).toBe(200)
    expect(fetchFile).toHaveBeenCalledExactlyOnceWith(pathToFileURL(join(ROOT, 'assets', 'a.js')).href)
  })

  it('answers 404 for a url outside the root, without reading anything', async () => {
    const { handle, fetchFile } = handler()
    for (const url of ['app://rill/..%2fx', 'app://other/index.html', 'file:///etc/passwd']) {
      expect((await handle({ url, method: 'GET' })).status, url).toBe(404)
    }
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('answers 404 when the file is missing and 405 for any method but GET and HEAD', async () => {
    const missing = handler(vi.fn(async () => Promise.reject(new Error('ENOENT'))))
    expect((await missing.handle({ url: 'app://rill/nope.js', method: 'GET' })).status).toBe(404)
    const { handle, fetchFile } = handler()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await handle({ url: 'app://rill/index.html', method })).status, method).toBe(405)
    expect((await handle({ url: 'app://rill/index.html', method: 'HEAD' })).status).toBe(200)
    expect(fetchFile).toHaveBeenCalledTimes(1)
  })
})
