import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECIPES, findRecipe, type ParamValues, type Recipe } from '@rill/recipes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScriptedProvider, type Step } from './plan-helpers'
import { SLACK_URL, startRecipeEnv, useCleanups } from './recipe-helpers'

useCleanups()

let dir: string
let allowed: string
let receipt: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rill-recipes-run-'))
  allowed = join(dir, 'allowed')
  mkdirSync(join(allowed, 'Receipts'), { recursive: true })
  receipt = join(allowed, 'Receipts', 'receipt.pdf')
  writeFileSync(receipt, Buffer.from('%PDF-1.4 fake'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const EXTRACTED = { amount: 250000, date: '2026-03-04', vendor: 'Acme Coffee' }

function rebased(recipe: Recipe): ParamValues {
  return Object.fromEntries(
    Object.entries(recipe.sample).map(([id, value]) => {
      const param = recipe.params.find((entry) => entry.id === id)!
      const isPath = param.kind === 'folder' || param.kind === 'file'
      return [id, isPath && typeof value === 'string' ? value.replace('/Users/demo', allowed) : value]
    }),
  )
}

const folderPayload = () => ({ file: receipt, name: 'receipt.pdf', extension: '.pdf', bytes: 13, modifiedAt: '2026-03-04T10:00:00.000Z' })
const cronPayload = () => ({ scheduledFor: '2026-03-04T09:00:00.000Z', firedAt: '2026-03-04T09:00:01.000Z' })
const webhookPayload = (path: string, body: unknown) => ({ method: 'POST', path, query: {}, headers: {}, body })

async function deployed(recipeId: string, steps: Step[] = []) {
  const recipe = findRecipe(recipeId)!
  const provider = new ScriptedProvider(steps)
  const env = await startRecipeEnv({ allowedRoots: [allowed], llm: provider })
  const draft = await env.client.request('instantiateRecipe', { recipeId, values: rebased(recipe) })
  const { workflowId } = await env.client.request('deploy', { workflow: draft.workflow })
  const dryRun = (payload: unknown) => env.engine.startRun(workflowId, payload, { dryRun: true })
  const run = (payload: unknown) => env.engine.startRun(workflowId, payload)
  const statuses = (runId: string) => Object.fromEntries(env.engine.getRunDetail(runId).steps.map((step) => [step.nodeId, step.status]))
  return { ...env, draft, provider, workflowId, dryRun, run, statuses }
}

describe('every recipe deploys and dry-runs through the real executor with fake services', () => {
  it('has a case below for each recipe of the catalogue', () => {
    expect(RECIPES.map((recipe) => recipe.id)).toEqual([
      'receipt-folder-to-csv',
      'receipt-big-amount-alert',
      'daily-health-check',
      'webhook-to-slack',
      'monthly-reminder',
      'failure-webhook-alert',
      'receipt-folder-to-google-sheet',
      'receipt-folder-to-excel',
    ])
  })

  it('receipt-folder-to-csv reads the receipt with the model, builds the row and writes nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, statuses, provider } = await deployed('receipt-folder-to-csv', [{ data: EXTRACTED }])
    const csv = join(allowed, 'ledger.csv')
    const result = await dryRun(folderPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.t1).toEqual(folderPayload())
    expect(result.outputs.n1).toEqual(EXTRACTED)
    expect(result.outputs.n2).toEqual({ file: csv, written: false })
    expect(statuses(result.runId)).toEqual({ n1: 'succeeded', n2: 'succeeded' })
    expect(existsSync(csv)).toBe(false)
    expect(provider.requests).toHaveLength(1)
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('application/pdf')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('receipt-big-amount-alert alerts above the threshold and skips the message below it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, statuses } = await deployed('receipt-big-amount-alert', [{ data: EXTRACTED }, { data: { ...EXTRACTED, amount: 500 } }, { data: { ...EXTRACTED, amount: 100000 } }])
    const big = await dryRun(folderPayload())
    expect(big.status).toBe('succeeded')
    expect(big.outputs.n3).toEqual({ result: true, branch: 'true' })
    expect(big.outputs.n4).toEqual({ sent: false, status: 0 })
    expect(big.outputs.n2).toEqual({ file: join(allowed, 'ledger.csv'), written: false })
    expect(statuses(big.runId)).toMatchObject({ n2: 'succeeded', n3: 'succeeded', n4: 'succeeded' })

    const small = await dryRun(folderPayload())
    expect(small.status).toBe('succeeded')
    expect(small.outputs.n3).toEqual({ result: false, branch: 'false' })
    expect(small.outputs).not.toHaveProperty('n4')
    expect(statuses(small.runId)).toMatchObject({ n2: 'succeeded', n3: 'succeeded', n4: 'skipped' })

    const equal = await dryRun(folderPayload())
    expect(equal.outputs.n3).toEqual({ result: false, branch: 'false' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('receipt-big-amount-alert fails the run, visibly, when the model finds no amount', async () => {
    const { dryRun, statuses } = await deployed('receipt-big-amount-alert', [{ data: { ...EXTRACTED, amount: null } }])
    const result = await dryRun(folderPayload())
    expect(result.status).toBe('failed')
    expect(result.error).toContain('n3')
    expect(statuses(result.runId)).toMatchObject({ n2: 'succeeded', n3: 'failed' })
  })

  it('daily-health-check calls nothing in a dry run, where the call counts as answered and no alert is sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, statuses } = await deployed('daily-health-check')
    const result = await dryRun(cronPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toEqual({ status: 0, headers: {}, body: null, dryRun: true })
    expect(result.outputs.n2).toEqual({ result: true, branch: 'true' })
    expect(result.outputs).not.toHaveProperty('n3')
    expect(statuses(result.runId)).toMatchObject({ n1: 'succeeded', n2: 'succeeded', n3: 'skipped' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('webhook-to-slack posts for a request and sends nothing in a dry run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, statuses } = await deployed('webhook-to-slack')
    const result = await dryRun(webhookPayload('/webhook-to-slack', { any: 'thing' }))
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toEqual({ sent: false, status: 0 })
    expect(statuses(result.runId)).toMatchObject({ n1: 'succeeded' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('monthly-reminder sends the message in a dry run to nobody', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, draft } = await deployed('monthly-reminder')
    const result = await dryRun(cronPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toEqual({ sent: false, status: 0 })
    expect(draft.workflow.nodes[1]!.config.text).toBe('Time to send the monthly report')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('failure-webhook-alert alerts for the failure status only', async () => {
    const { dryRun, statuses } = await deployed('failure-webhook-alert')
    const failed = await dryRun(webhookPayload('/failure-alert', { status: 'error', job: 'backup' }))
    expect(failed.status).toBe('succeeded')
    expect(failed.outputs.n1).toEqual({ result: true, branch: 'true' })
    expect(failed.outputs.n2).toEqual({ sent: false, status: 0 })

    for (const body of [{ status: 'ok' }, { status: 'failed' }, {}, 'text', null]) {
      const calm = await dryRun(webhookPayload('/failure-alert', body))
      expect(calm.status, JSON.stringify(body)).toBe('succeeded')
      expect(calm.outputs.n1, JSON.stringify(body)).toEqual({ result: false, branch: 'false' })
      expect(statuses(calm.runId), JSON.stringify(body)).toMatchObject({ n1: 'succeeded', n2: 'skipped' })
    }
  })

  it('failure-webhook-alert compares the status as text, so a number in the body does not match', async () => {
    const recipe = findRecipe('failure-webhook-alert')!
    const env = await startRecipeEnv({ allowedRoots: [allowed] })
    const draft = await env.client.request('instantiateRecipe', { recipeId: recipe.id, values: { ...recipe.sample, failedStatus: '500' } })
    const { workflowId: id } = await env.client.request('deploy', { workflow: draft.workflow })
    const send = (body: unknown) => env.engine.startRun(id, webhookPayload('/failure-alert', body), { dryRun: true })
    expect((await send({ status: '500' })).outputs.n1).toEqual({ result: true, branch: 'true' })
    expect((await send({ status: 500 })).outputs.n1).toEqual({ result: false, branch: 'false' })
    expect((await send({ status: false })).outputs.n1).toEqual({ result: false, branch: 'false' })
  })

  it('a value that looks like a reference never reaches a node as one', async () => {
    const recipe = findRecipe('failure-webhook-alert')!
    const env = await startRecipeEnv({ allowedRoots: [allowed] })
    const draft = await env.client.request('instantiateRecipe', {
      recipeId: recipe.id,
      values: { ...recipe.sample, failedStatus: '{"$param":"slackConnection"}' },
    })
    expect(draft.workflow.nodes[1]!.config.right).toBe('{"$param":"slackConnection"}')
    const { workflowId } = await env.client.request('deploy', { workflow: draft.workflow })
    const result = await env.engine.startRun(workflowId, webhookPayload('/failure-alert', { status: '{"$param":"slackConnection"}' }), { dryRun: true })
    expect(result.outputs.n1).toEqual({ result: true, branch: 'true' })
  })
})

describe('the spreadsheet recipes', () => {
  it('receipt-folder-to-google-sheet reads the receipt with the model and appends nothing in a dry run, with no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, statuses, provider, draft } = await deployed('receipt-folder-to-google-sheet', [{ data: EXTRACTED }])
    const result = await dryRun(folderPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toEqual(EXTRACTED)
    expect(result.outputs.n2).toEqual({ appended: false, updatedRange: '' })
    expect(statuses(result.runId)).toEqual({ n1: 'succeeded', n2: 'succeeded' })
    expect(provider.requests).toHaveLength(1)
    expect(draft.workflow.nodes[2]!.config).toMatchObject({ connection: 'google', values: ['{{n1.output.date}}', '{{n1.output.vendor}}', '{{n1.output.amount}}'] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('receipt-folder-to-excel reads the receipt with the model and appends nothing in a dry run, with no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is not allowed'))
    const { dryRun, statuses, provider, draft } = await deployed('receipt-folder-to-excel', [{ data: EXTRACTED }])
    const result = await dryRun(folderPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toEqual(EXTRACTED)
    expect(result.outputs.n2).toEqual({ appended: false })
    expect(statuses(result.runId)).toEqual({ n1: 'succeeded', n2: 'succeeded' })
    expect(provider.requests).toHaveLength(1)
    expect(draft.workflow.nodes[2]!.config).toMatchObject({ connection: 'microsoft', filePath: 'Receipts/ledger.xlsx', table: 'Expenses' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a draft of an account that is not connected, by the connection that the validator does not know', async () => {
    for (const [recipeId, connection] of [['receipt-folder-to-google-sheet', 'googleConnection'], ['receipt-folder-to-excel', 'microsoftConnection']] as const) {
      const recipe = findRecipe(recipeId)!
      const env = await startRecipeEnv({ allowedRoots: [allowed], planConnections: [] })
      const error = await env.client.request('instantiateRecipe', { recipeId, values: rebased(recipe) }).catch((caught: unknown) => caught as { code?: string; problems?: string[] })
      expect(error, connection).toMatchObject({ code: 'RECIPE_INVALID', problems: ['unknown_connection at /nodes/2/config/connection'] })
    }
  })
})

describe('daily-health-check in a real run, with a fake network', () => {
  const HEALTH = 'https://example.test/health'
  const ALERT = '서버 상태 확인에 실패했어요. 응답이 없거나 성공 응답이 아니에요.'

  function network(answer: () => Response | Promise<Response>) {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined })
      if (url === HEALTH) return answer()
      if (url === SLACK_URL) return new Response('ok', { status: 200 })
      throw new Error(`unexpected call to ${url}`)
    })
    return calls
  }

  it.each([
    [200, 'ok'],
    [201, 'created'],
    [204, null],
    [299, 'edge of the range'],
  ])('sends no alert for the answer %i, since every 2xx answer is healthy', async (status, body) => {
    const calls = network(() => new Response(body, { status }))
    const { run, statuses } = await deployed('daily-health-check')
    const result = await run(cronPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n1).toMatchObject({ status })
    expect(result.outputs.n2).toEqual({ result: true, branch: 'true' })
    expect(statuses(result.runId)).toMatchObject({ n1: 'succeeded', n2: 'succeeded', n3: 'skipped' })
    expect(calls.map((call) => call.url)).toEqual([HEALTH])
  })

  it.each([
    ['a 503, tried twice', () => new Response('down', { status: 503 }), 2],
    ['a 500, tried twice', () => new Response('error', { status: 500 }), 2],
    ['a 429, tried twice', () => new Response('slow down', { status: 429 }), 2],
    ['a 404, tried once', () => new Response('gone', { status: 404 }), 1],
    ['a 403, tried once', () => new Response('no', { status: 403 }), 1],
    ['a redirect, tried once', () => new Response(null, { status: 301, headers: { location: 'https://example.test/other' } }), 1],
    ['a network error, tried twice', () => Promise.reject(new TypeError('fetch failed')), 2],
  ])('sends one alert for %s', async (_name, answer, attempts) => {
    const calls = network(answer)
    const { run, statuses } = await deployed('daily-health-check')
    const result = await run(cronPayload())
    expect(result.status).toBe('succeeded')
    expect(result.outputs.n2).toEqual({ result: false, branch: 'false' })
    expect(result.outputs.n3).toEqual({ sent: true, status: 200 })
    expect(statuses(result.runId)).toMatchObject({ n2: 'succeeded', n3: 'succeeded' })
    expect(calls.filter((call) => call.url === HEALTH)).toHaveLength(attempts)
    expect(calls.filter((call) => call.url === SLACK_URL)).toEqual([{ url: SLACK_URL, body: { text: ALERT } }])
  })
})
