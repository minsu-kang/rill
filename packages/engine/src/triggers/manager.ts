import { isTrigger } from '@rill/dsl'
import type {
  ConnectionResolver,
  CronTriggerConfig,
  FolderWatchConfig,
  NodeRegistry,
  WebhookTriggerConfig,
} from '@rill/nodes-core'
import Value from 'typebox/value'
import type { Clock } from '../clock'
import type { Store } from '../store'
import { CronRuntime } from './cron'
import { FolderRuntime } from './folder'
import type { TriggerHost, TriggerRuntime } from './types'
import { WebhookHub, WebhookRuntime } from './webhook'

export interface TriggerManagerDeps {
  store: Store
  registry: NodeRegistry
  clock: Clock
  fire: TriggerHost['fire']
  isBusy: TriggerHost['isBusy']
  emit: TriggerHost['emit']
  allowedRoots: string[] | undefined
  connections: ConnectionResolver
  webhookPort: number
}

export class TriggerManager {
  private readonly deps: TriggerManagerDeps
  private readonly host: TriggerHost
  private readonly runtimes = new Map<string, TriggerRuntime>()
  private readonly activating = new Map<string, Promise<void>>()
  private readonly cancelled = new Set<string>()
  private hub: WebhookHub | undefined

  constructor(deps: TriggerManagerDeps) {
    this.deps = deps
    this.host = { store: deps.store, clock: deps.clock, fire: deps.fire, isBusy: deps.isBusy, emit: deps.emit }
  }

  get webhookPort(): number | undefined {
    return this.hub?.port
  }

  activate(workflowId: string): Promise<void> {
    const pending = this.activating.get(workflowId)
    if (pending) return pending
    if (this.runtimes.has(workflowId)) return Promise.resolve()
    this.cancelled.delete(workflowId)
    const task = this.start(workflowId).finally(() => {
      this.activating.delete(workflowId)
    })
    this.activating.set(workflowId, task)
    return task
  }

  isActive(workflowId: string): boolean {
    return this.runtimes.has(workflowId) || this.activating.has(workflowId)
  }

  deactivate(workflowId: string): void {
    if (this.activating.has(workflowId)) this.cancelled.add(workflowId)
    this.runtimes.get(workflowId)?.stop()
    this.runtimes.delete(workflowId)
    this.deps.store.setWorkflowActive(workflowId, false)
    this.deps.store.clearNextFire(workflowId)
    this.deps.emit({ type: 'workflow.deactivated', workflowId })
  }

  async resumeActive(): Promise<void> {
    for (const workflowId of this.deps.store.listActiveWorkflowIds()) {
      try {
        await this.activate(workflowId)
      } catch (error) {
        this.deps.emit({
          type: 'trigger.error',
          workflowId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async idle(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.idle?.()))
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.activating.values()])
    for (const runtime of this.runtimes.values()) runtime.stop()
    await this.idle()
    this.runtimes.clear()
    const hub = this.hub
    this.hub = undefined
    await hub?.close()
  }

  private async start(workflowId: string): Promise<void> {
    const workflow = this.deps.store.getWorkflow(workflowId)
    const node = workflow.nodes.find((n) => isTrigger(n.type))
    if (!node) throw new Error('workflow has no trigger')
    const def = this.deps.registry.get(node.type)
    if (!def || def.kind !== 'trigger') throw new Error(`unknown trigger type: ${node.type}`)
    if (!Value.Check(def.configSchema, node.config)) throw new Error(`trigger ${node.id} has an invalid config`)
    const runtime = await this.createRuntime(workflowId, node.type, node.config)
    if (this.cancelled.delete(workflowId)) {
      runtime.stop()
      return
    }
    this.runtimes.set(workflowId, runtime)
    this.deps.store.setWorkflowActive(workflowId, true)
    this.deps.emit({ type: 'workflow.activated', workflowId })
  }

  private async createRuntime(workflowId: string, type: string, config: unknown): Promise<TriggerRuntime> {
    switch (type) {
      case 'trigger.cron@1': {
        const runtime = new CronRuntime(workflowId, config as CronTriggerConfig, this.host)
        runtime.start()
        return runtime
      }
      case 'trigger.folderWatch@1': {
        const runtime = new FolderRuntime(workflowId, config as FolderWatchConfig, this.host, this.deps.allowedRoots)
        runtime.start()
        return runtime
      }
      case 'trigger.webhook@1': {
        const webhook = config as WebhookTriggerConfig
        let secret: string | undefined
        if (webhook.secretConnection !== undefined) {
          secret = this.deps.connections.get(webhook.secretConnection)
          if (secret === undefined) throw new Error(`unknown connection: ${webhook.secretConnection}`)
        }
        this.hub ??= new WebhookHub(this.deps.webhookPort)
        await this.hub.listen()
        return new WebhookRuntime(workflowId, webhook, secret, this.hub, this.host)
      }
      case 'trigger.manual@1':
        throw new Error('manual triggers cannot be activated; start runs with startRun')
      default:
        throw new Error(`no runtime for trigger type: ${type}`)
    }
  }
}
