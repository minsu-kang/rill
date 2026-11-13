import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SeenRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

export interface TestServer {
  base: string
  seen: SeenRequest[]
  close(): Promise<void>
}

export async function startTestServer(): Promise<TestServer> {
  const seen: SeenRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const route = (req.url ?? '').split('?')[0]
      if (route === '/echo-request' || route === '/echo-error') {
        res.statusCode = route === '/echo-error' ? 400 : 200
        res.setHeader('content-type', 'application/json')
        res.setHeader('x-echo-auth', String(req.headers.authorization ?? ''))
        res.end(JSON.stringify({ url: req.url, headers: req.headers }))
        return
      }
      if (route === '/echo-late') {
        res.statusCode = 401
        res.setHeader('content-type', 'text/plain')
        res.end(`${'x'.repeat(183)}invalid key ${String(req.headers['x-api-key'] ?? '')}`)
        return
      }
      if (route === '/echo-as-key') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ [String(req.headers['x-api-key'] ?? '')]: 1 }))
        return
      }
      switch (req.url) {
        case '/json':
          res.setHeader('content-type', 'application/json')
          res.end('{"hello":"world"}')
          break
        case '/text':
          res.end('plain')
          break
        case '/echo':
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ received: body }))
          break
        case '/busy':
          res.statusCode = 503
          res.end('busy')
          break
        case '/limited':
          res.statusCode = 429
          res.end('slow down')
          break
        case '/missing':
          res.statusCode = 404
          res.end('nope')
          break
        case '/redirect':
          res.statusCode = 301
          res.setHeader('location', '/json')
          res.end()
          break
        case '/big':
          res.end('x'.repeat(5000))
          break
        case '/hang':
          break
        default:
          res.statusCode = 500
          res.end('unknown route')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}
