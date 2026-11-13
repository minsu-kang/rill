import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { PlanIssue } from '@rill/dsl'
import { LlmError } from '@rill/llm'
import { AttachmentError, ExplainError, PlanError } from '@rill/planner'
import {
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  errorResponse,
  okResponse,
  parseRequest,
  tokenFromProtocols,
  validateParams,
  type EngineEvent,
  type ErrorBody,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ServerMessage,
} from '@rill/protocol'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { AgentBuiltinError, AgentDuplicateError, AgentFullError, AgentInvalidError, AgentNotFoundError } from '../agents'
import { WorkflowBusyError, WorkflowValidationError, type Engine } from '../engine'
import { ExplainBusyError, RunNotExplainableError } from '../explain'
import { MemoryDuplicateError, MemoryFullError, MemoryInvalidError } from '../memory'
import {
  LlmUnavailableError,
  PlanBusyError,
  PlanDeployedError,
  PlanExistsError,
  PlanNotConfirmedError,
  PlanNotFoundError,
} from '../plans'
import { RecipeInvalidError, RecipeNotFoundError } from '../recipes'
import { RuleDuplicateError, RuleFullError, RuleInvalidError, RuleNotFoundError, RuleViolationError } from '../rules'
import { NotFoundError } from '../store'

const OPEN = 1
const CLOSED = 3
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{16,}$/
const MAX_PROBLEMS = 20
const NAME_ONLY_ERROR_METHODS: ReadonlySet<string> = new Set(['plan', 'deployPlan', 'saveMemory', 'saveRule', 'deleteRule', 'saveAgent', 'explainRun', 'instantiateRecipe'])

export interface RillServerOptions {
  engine: Engine
  token: string
  port?: number
  allowedOrigins?: string[]
  maxConnections?: number
  maxMessageBytes?: number
  maxBufferedBytes?: number
  pingIntervalMs?: number
  closeTimeoutMs?: number
  log?: (line: string) => void
}

interface Client {
  socket: WebSocket
  alive: boolean
  gone: AbortController
}

type Handlers = {
  [M in MethodName]: (params: MethodParams<M>, signal: AbortSignal) => MethodResult<M> | Promise<MethodResult<M>>
}

function sameToken(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(given).digest()
  return timingSafeEqual(a, b)
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function issueProblems(issues: readonly PlanIssue[]): string[] {
  return issues.slice(0, MAX_PROBLEMS).map((issue) => `${issue.code} at ${issue.pointer === '' ? '/' : issue.pointer}`)
}

const BILLING_CATEGORY = /quota|credit|payment|billing|limit_exceeded/i

function authBody(error: LlmError): ErrorBody {
  const billing = error.status === 402 || error.status === 429 || (error.category !== undefined && BILLING_CATEGORY.test(error.category))
  if (billing) return { code: 'LLM_UNAVAILABLE', message: 'the model provider reports a billing or quota problem' }
  if (error.status === 403) return { code: 'LLM_UNAVAILABLE', message: 'the model provider refused account access' }
  return { code: 'LLM_UNAVAILABLE', message: 'the model provider rejected the credentials' }
}

function planErrorBody(error: PlanError): ErrorBody {
  switch (error.kind) {
    case 'provider':
      return error.cause instanceof LlmError && error.cause.kind === 'auth' ? authBody(error.cause) : { code: 'PLAN_PROVIDER', message: 'the model provider failed' }
    case 'invalid_after_repair':
      return { code: 'PLAN_INVALID', message: 'no valid plan after the repair rounds', problems: issueProblems(error.lastIssues) }
    case 'invalid_request':
      return { code: 'INVALID_PARAMS', message: 'the request does not fit the existing workflow', problems: issueProblems(error.lastIssues) }
    case 'aborted':
      return { code: 'PLAN_CANCELLED', message: 'planning was cancelled' }
    case 'attachment':
      return { code: 'ATTACHMENT_REJECTED', message: error.message }
  }
}

function explainErrorBody(error: ExplainError): ErrorBody {
  switch (error.kind) {
    case 'provider':
      return error.cause instanceof LlmError && error.cause.kind === 'auth' ? authBody(error.cause) : { code: 'EXPLAIN_PROVIDER', message: 'the model provider failed' }
    case 'invalid':
      return { code: 'EXPLAIN_INVALID', message: 'the model did not return a usable explanation' }
    case 'aborted':
      return { code: 'EXPLAIN_PROVIDER', message: 'the explanation was cancelled' }
  }
}

function toErrorBody(method: string, error: unknown): ErrorBody {
  if (error instanceof WorkflowValidationError) {
    const problems = method === 'deployPlan' ? issueProblems(error.problemIssues) : error.problems
    return { code: 'INVALID_WORKFLOW', message: 'the workflow is not valid', problems }
  }
  if (error instanceof WorkflowBusyError) return { code: 'WORKFLOW_BUSY', message: error.message }
  if (error instanceof PlanError) return planErrorBody(error)
  if (error instanceof ExplainError) return explainErrorBody(error)
  if (error instanceof RunNotExplainableError) return { code: 'RUN_NOT_EXPLAINABLE', message: error.message }
  if (error instanceof ExplainBusyError) return { code: 'EXPLAIN_BUSY', message: error.message }
  if (error instanceof RecipeInvalidError) return { code: 'RECIPE_INVALID', message: error.message, problems: error.problems }
  if (error instanceof RecipeNotFoundError) return { code: 'NOT_FOUND', message: error.message }
  if (error instanceof MemoryInvalidError) return { code: 'MEMORY_INVALID', message: 'the note is not valid', problems: error.problems }
  if (error instanceof MemoryFullError) return { code: 'MEMORY_FULL', message: error.message }
  if (error instanceof MemoryDuplicateError) return { code: 'MEMORY_DUPLICATE', message: error.message }
  if (error instanceof RuleViolationError) {
    return method === 'activate'
      ? { code: 'ACTIVATION_FAILED', message: error.message }
      : { code: 'RULE_VIOLATION', message: error.message, problems: issueProblems(error.issues) }
  }
  if (error instanceof RuleInvalidError) return { code: 'RULE_INVALID', message: 'the rule is not valid', problems: error.problems }
  if (error instanceof RuleFullError) return { code: 'RULE_FULL', message: error.message }
  if (error instanceof RuleDuplicateError) return { code: 'RULE_DUPLICATE', message: error.message }
  if (error instanceof RuleNotFoundError) return { code: 'RULE_NOT_FOUND', message: error.message }
  if (error instanceof AgentInvalidError) return { code: 'AGENT_INVALID', message: 'the agent is not valid', problems: error.problems }
  if (error instanceof AgentFullError) return { code: 'AGENT_FULL', message: error.message }
  if (error instanceof AgentDuplicateError) return { code: 'AGENT_DUPLICATE', message: error.message }
  if (error instanceof AgentNotFoundError) return { code: 'AGENT_NOT_FOUND', message: error.message }
  if (error instanceof AgentBuiltinError) return { code: 'AGENT_BUILTIN', message: error.message }
  if (error instanceof LlmError && error.kind === 'auth') return authBody(error)
  if (error instanceof AttachmentError) return { code: 'ATTACHMENT_REJECTED', message: error.message }
  if (error instanceof LlmUnavailableError) return { code: 'LLM_UNAVAILABLE', message: error.message }
  if (error instanceof PlanBusyError) return { code: 'PLAN_BUSY', message: error.message }
  if (error instanceof PlanExistsError) return { code: 'PLAN_EXISTS', message: error.message }
  if (error instanceof PlanNotConfirmedError) return { code: 'PLAN_NOT_CONFIRMED', message: error.message }
  if (error instanceof PlanDeployedError) return { code: 'PLAN_DEPLOYED', message: error.message }
  if (error instanceof PlanNotFoundError || error instanceof NotFoundError) return { code: 'NOT_FOUND', message: error.message }
  if (method === 'activate' && error instanceof Error) return { code: 'ACTIVATION_FAILED', message: error.message }
  return { code: 'INTERNAL', message: 'internal error' }
}

export class RillServer {
  private readonly engine: Engine
  private readonly token: string
  private readonly preferredPort: number
  private readonly allowedOrigins: string[]
  private readonly maxConnections: number
  private readonly maxMessageBytes: number
  private readonly maxBufferedBytes: number
  private readonly pingIntervalMs: number
  private readonly closeTimeoutMs: number
  private readonly log: (line: string) => void
  private readonly clients = new Set<Client>()
  private readonly handlers: Handlers
  private http: Server | undefined
  private wss: WebSocketServer | undefined
  private unsubscribe: (() => void) | undefined
  private pinger: ReturnType<typeof setInterval> | undefined
  private boundPort: number | undefined
  private listening: Promise<number> | undefined
  private closing: Promise<void> | undefined

  constructor(options: RillServerOptions) {
    if (!TOKEN_PATTERN.test(options.token)) {
      throw new Error(
        "token must be at least 16 characters, each a letter, a digit or one of !#$%&'*+-.^_`|~ (it travels as a WebSocket subprotocol)",
      )
    }
    this.engine = options.engine
    this.token = options.token
    this.preferredPort = options.port ?? 0
    this.allowedOrigins = options.allowedOrigins ?? []
    this.maxConnections = options.maxConnections ?? 8
    this.maxMessageBytes = options.maxMessageBytes ?? 1_048_576
    this.maxBufferedBytes = options.maxBufferedBytes ?? 8_388_608
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000
    this.closeTimeoutMs = options.closeTimeoutMs ?? 1000
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
    this.handlers = this.createHandlers()
  }

  get port(): number | undefined {
    return this.boundPort
  }

  get clientCount(): number {
    return this.clients.size
  }

  listen(): Promise<number> {
    if (this.closing) return this.closing.then(() => this.listen())
    this.listening ??= this.start()
    return this.listening
  }

  close(): Promise<void> {
    this.closing ??= this.stop().finally(() => {
      this.closing = undefined
    })
    return this.closing
  }

  private async stop(): Promise<void> {
    await this.listening?.catch(() => undefined)
    const http = this.http
    const wss = this.wss
    this.http = undefined
    this.wss = undefined
    this.listening = undefined
    this.boundPort = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = undefined
    if (!http || !wss) return
    const open = [...this.clients]
    const closed = Promise.all(
      open.map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.socket.readyState === CLOSED) resolve()
            else client.socket.once('close', () => resolve())
          }),
      ),
    )
    for (const client of open) client.socket.close(1001, 'server is shutting down')
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.closeTimeoutMs)
      }),
    ])
    clearTimeout(timer)
    for (const client of open) client.socket.terminate()
    wss.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    this.clients.clear()
  }

  private async start(): Promise<number> {
    const http = createServer((_req, res) => {
      res.writeHead(404, { 'content-length': 0 })
      res.end()
    })
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxMessageBytes,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    })
    http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject)
        http.listen(this.preferredPort, '127.0.0.1', () => resolve())
      })
    } catch (error) {
      this.listening = undefined
      throw error
    }
    this.http = http
    this.wss = wss
    this.boundPort = (http.address() as AddressInfo).port
    this.unsubscribe = this.engine.on((event) => this.broadcast(event))
    this.pinger = setInterval(() => this.ping(), this.pingIntervalMs)
    return this.boundPort
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined)
    const wss = this.wss
    if (!wss) {
      socket.destroy()
      return
    }
    const port = this.boundPort
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    if (!hosts.includes(req.headers.host ?? '')) return refuse(socket, 403, 'Forbidden')
    if (req.url !== '/') return refuse(socket, 404, 'Not Found')
    const origin = req.headers.origin
    if (origin !== undefined && !this.allowedOrigins.includes(origin)) return refuse(socket, 403, 'Forbidden')
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((entry) => entry.trim())
    if (!offered.includes(SUBPROTOCOL) || !sameToken(this.token, tokenFromProtocols(offered))) {
      return refuse(socket, 401, 'Unauthorized')
    }
    if (this.clients.size >= this.maxConnections) return refuse(socket, 503, 'Service Unavailable')
    wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws))
  }

  private connect(socket: WebSocket): void {
    const client: Client = { socket, alive: true, gone: new AbortController() }
    this.clients.add(client)
    socket.on('error', () => undefined)
    socket.on('pong', () => {
      client.alive = true
    })
    socket.on('close', () => {
      this.clients.delete(client)
      client.gone.abort()
    })
    socket.on('message', (data, isBinary) => {
      void this.onMessage(client, data, isBinary)
    })
    this.send(client, { type: 'hello', protocol: PROTOCOL_VERSION })
  }

  private async onMessage(client: Client, data: RawData, isBinary: boolean): Promise<void> {
    if (client.socket.readyState !== OPEN) return
    if (isBinary) {
      client.socket.close(1003, 'binary frames are not supported')
      return
    }
    const parsed = parseRequest(rawToString(data))
    if (!parsed.ok) {
      client.socket.close(1008, 'invalid message')
      return
    }
    const { id, method } = parsed.value
    const checked = validateParams(method, parsed.value.params)
    if (!checked.ok) {
      this.send(
        client,
        errorResponse(id, {
          code: checked.code,
          message: checked.problems[0] ?? 'invalid request',
          problems: checked.problems,
        }),
      )
      return
    }
    try {
      const handler = this.handlers[checked.method] as (params: unknown, signal: AbortSignal) => unknown
      this.send(client, okResponse(id, await handler(checked.params, client.gone.signal)))
    } catch (error) {
      const body = toErrorBody(method, error)
      if (body.code === 'INTERNAL') this.logError(method, error)
      this.send(client, errorResponse(id, body))
    }
  }

  private logError(method: string, error: unknown): void {
    const detail = NAME_ONLY_ERROR_METHODS.has(method)
      ? { name: error instanceof Error ? error.name : typeof error }
      : { message: error instanceof Error ? error.message : String(error) }
    this.log(JSON.stringify({ type: 'error', method, ...detail }))
  }

  private send(client: Client, message: ServerMessage): void {
    this.deliver(client, JSON.stringify(message))
  }

  private broadcast(event: EngineEvent): void {
    const text = JSON.stringify({ type: 'event', event })
    for (const client of this.clients) this.deliver(client, text)
  }

  private deliver(client: Client, text: string): void {
    const socket = client.socket
    if (socket.readyState !== OPEN) return
    if (socket.bufferedAmount > this.maxBufferedBytes) {
      socket.close(1013, 'client is too slow')
      return
    }
    socket.send(text, (error) => {
      if (error) socket.terminate()
    })
  }

  private ping(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate()
        continue
      }
      client.alive = false
      try {
        client.socket.ping()
      } catch {
        client.socket.terminate()
      }
    }
  }

  private createHandlers(): Handlers {
    const engine = this.engine
    return {
      deploy: (params) => ({ workflowId: engine.deploy(params.workflow) }),
      getWorkflow: (params) => ({ workflow: engine.getWorkflow(params.workflowId) }),
      listWorkflows: () => ({ workflows: engine.listWorkflows() }),
      startRun: (params) => {
        engine.getWorkflow(params.workflowId)
        const { runId, done } = engine.enqueueRun(params.workflowId, params.payload ?? {}, {
          dryRun: params.dryRun,
          deferStart: true,
        })
        done.catch((error: unknown) => this.logError('startRun', error))
        return { runId }
      },
      activate: async (params) => {
        engine.getWorkflow(params.workflowId)
        await engine.activate(params.workflowId)
        return {}
      },
      deactivate: (params) => {
        engine.getWorkflow(params.workflowId)
        engine.deactivate(params.workflowId)
        return {}
      },
      deleteWorkflow: (params) => {
        engine.deleteWorkflow(params.workflowId)
        return {}
      },
      listRuns: (params) => ({ runs: engine.listRuns({ workflowId: params.workflowId, limit: params.limit }) }),
      getRun: (params) => engine.getRunDetail(params.runId),
      nodeCatalog: () => ({ nodes: engine.nodeCatalog() }),
      listMemory: () => ({ items: engine.listMemory() }),
      saveMemory: (params) => ({ item: engine.saveMemory({ text: params.text, ...(params.id === undefined ? {} : { id: params.id }) }) }),
      deleteMemory: (params) => ({ deleted: engine.deleteMemory(params.id) }),
      listRules: () => ({ rules: engine.listRules() }),
      saveRule: (params) => ({ rule: engine.saveRule(params) }),
      deleteRule: (params) => ({ deleted: engine.deleteRule(params.id) }),
      checkRules: () => ({ violations: engine.checkRules() }),
      listAgents: () => engine.listAgents(),
      saveAgent: (params) => ({ agent: engine.saveAgent(params) }),
      deleteAgent: (params) => ({ deleted: engine.deleteAgent(params.id) }),
      setActiveAgent: (params) => {
        engine.setActiveAgent(params.id)
        return {}
      },
      llmModels: () => engine.llmModels(),
      listRecipes: () => ({ recipes: engine.listRecipes() }),
      instantiateRecipe: (params) => engine.instantiateRecipe(params),
      explainRun: async (params, signal) => {
        const result = await engine.explainRun({
          runId: params.runId,
          ...(params.effort === undefined ? {} : { effort: params.effort }),
          ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
          signal,
        })
        return {
          runId: params.runId,
          explanation: result.explanation,
          likelyCause: result.likelyCause,
          suggestedActions: result.suggestedActions,
          ...(result.fixProposal === undefined ? {} : { fixProposal: result.fixProposal }),
          signals: result.signals,
          meta: result.meta,
        }
      },
      plan: (params) => engine.plan(params),
      cancelPlan: (params) => ({ cancelled: engine.cancelPlan(params.planId) }),
      getPlan: (params) => ({ plan: engine.getPlan(params.planId) }),
      listPlans: (params) => ({ plans: engine.listPlans({ limit: params.limit }) }),
      deployPlan: (params) => ({ workflowId: engine.deployPlan(params.planId, params.confirmed) }),
      ping: () => ({ time: Date.now() }),
    }
  }
}
