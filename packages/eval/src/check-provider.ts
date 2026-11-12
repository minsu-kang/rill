import { parseArgs } from 'node:util'
import { PROVIDER_IDS, LlmError, providerDescriptor, type LiveCheck, type LlmProvider, type LlmRequest, type LlmUsage, type ProviderId } from '@rill/llm'
import { formatUsdPlain, money, plural } from './budget'
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError, effectiveEndpoint, endpointCheck, type CliIo } from './cli-shared'
import { PRICE_TABLE_AS_OF, costUsd, estimateCallUsd, priceFor } from './pricing'
import { createSpecProvider, describeSpec } from './providers'
import type { FetchFn } from './record'
import { modelIdOf, softCapFactor } from './spec'

export const CHECK_CALL_NAMES = ['text', 'repeat', 'image', 'pdf'] as const
export type CheckCallName = (typeof CHECK_CALL_NAMES)[number]

export type LiveStatus = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface LiveResult {
  id: string
  what: string
  status: LiveStatus
  measured: string
}

export interface CallRecord {
  name: CheckCallName
  status: 'ok' | 'error' | 'not-run'
  reason?: string
  data?: unknown
  dataValid?: boolean
  usage?: LlmUsage
  raw?: unknown
  servedModel?: string
  error?: { kind: string; message: string }
  durationMs?: number
}

export interface Measurements {
  spec: string
  requestedModel: string
  prefixTokens: number
  calls: Record<CheckCallName, CallRecord>
}

export interface CheckProviderConfig {
  provider: ProviderId
  model: string
  budgetUsd: number
  yes: boolean
  dry: boolean
  allowBaseUrl: boolean
  help: boolean
}

export const CHECK_DEFAULT_BUDGET_USD = 0.25
const CHECK_MAX_TOKENS = 2000
const CHECK_MAX_CALL_MS = 120_000
const CHARS_PER_TOKEN = 3.5
const IMAGE_TOKENS = 1500
const PDF_TOKENS = 2400
const COMMAND = 'pnpm eval check-provider'
const MAX_MEASURED = 160
const PREFIX_LINES = 170

export const CHECK_USAGE = `usage: ${COMMAND} --provider <id> --model <id> [options]

Sends at most four tiny calls to one provider and prints every LIVE_CHECKS entry of its adapter with what was measured: PASS, FAIL or UNKNOWN.
The calls are a schema round trip with an optional field, the same cached prefix again (to see a cache read), an image, and a PDF
(a model that reads no PDF is asked anyway and must refuse before any request). Without --yes nothing is sent.

options:
  --provider <id>         ${PROVIDER_IDS.join(', ')}
  --model <id>            a model id of that provider (for example gpt-6.1-sol)
  --budget-usd <usd>      spending cap (default: ${CHECK_DEFAULT_BUDGET_USD}); the guard stops before a call whose worst case does not fit
  --dry                   print the plan and the cost, send nothing (also what happens without --yes); cannot be combined with --yes
  --yes                   really call the API; needs the key of the provider in the environment
  --allow-base-url        allow an ANTHROPIC_BASE_URL other than the default (Anthropic only; the key is sent to that host)
  -h, --help              show this text

exit codes: 0 done, 1 runtime error (also: the key was rejected), 2 usage error
`

export function parseCheckProviderArgs(argv: readonly string[]): CheckProviderConfig {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        'budget-usd': { type: 'string' },
        dry: { type: 'boolean' },
        yes: { type: 'boolean' },
        'allow-base-url': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values } = parsed
  if (values.help === true) return { provider: 'anthropic', model: '', budgetUsd: CHECK_DEFAULT_BUDGET_USD, yes: false, dry: false, allowBaseUrl: false, help: true }
  if (values.provider === undefined) throw new UsageError(`--provider is required: ${PROVIDER_IDS.join(', ')}`)
  const provider = PROVIDER_IDS.find((id) => id === values.provider)
  if (provider === undefined) throw new UsageError(`unknown provider '${values.provider}'; known providers: ${PROVIDER_IDS.join(', ')}`)
  const descriptor = providerDescriptor(provider)
  if (values.model === undefined || values.model.trim() === '') {
    throw new UsageError(`--model is required; models of ${descriptor.label}: ${descriptor.models.map((model) => model.id).join(', ')}`)
  }
  const model = values.model.trim()
  describeSpec(provider === 'anthropic' ? model : `${provider}:${model}`)
  let budgetUsd = CHECK_DEFAULT_BUDGET_USD
  if (values['budget-usd'] !== undefined) {
    budgetUsd = Number(values['budget-usd'])
    if (!/^\d+(\.\d+)?$/u.test(values['budget-usd']) || !Number.isFinite(budgetUsd) || !(budgetUsd > 0)) {
      throw new UsageError('--budget-usd must be a finite positive number of dollars, for example 0.25')
    }
  }
  if (values.yes === true && values.dry === true) throw new UsageError('--dry cannot be combined with --yes: a dry run never calls the API')
  return { provider, model, budgetUsd, yes: values.yes === true, dry: values.dry === true, allowBaseUrl: values['allow-base-url'] === true, help: false }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function findUsage(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 4) return undefined
  if (isRecord(value['usage'])) return value['usage']
  for (const child of Object.values(value)) {
    const found = findUsage(child, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

export function rawUsageOf(body: string): Record<string, unknown> | undefined {
  try {
    return findUsage(JSON.parse(body))
  } catch {
    let last: Record<string, unknown> | undefined
    for (const block of body.split(/\r?\n\r?\n/u)) {
      const line = block.split(/\r?\n/u).find((entry) => entry.startsWith('data:'))
      if (line === undefined) continue
      try {
        last = findUsage(JSON.parse(line.slice(5).trim())) ?? last
      } catch {
        continue
      }
    }
    return last
  }
}

export interface RawNumbers {
  input?: number
  cached?: number
  output?: number
  reasoning?: number
  total?: number
}

function numberAt(raw: unknown, path: readonly string[]): number | undefined {
  let current: unknown = raw
  for (const key of path) current = isRecord(current) ? current[key] : undefined
  return typeof current === 'number' ? current : undefined
}

function firstNumber(raw: unknown, paths: readonly (readonly string[])[]): number | undefined {
  for (const path of paths) {
    const value = numberAt(raw, path)
    if (value !== undefined) return value
  }
  return undefined
}

export function rawUsageNumbers(raw: unknown): RawNumbers {
  const fields: [keyof RawNumbers, (readonly string[])[]][] = [
    ['input', [['input_tokens'], ['total_input_tokens'], ['prompt_tokens']]],
    ['cached', [['input_tokens_details', 'cached_tokens'], ['total_cached_tokens'], ['prompt_tokens_details', 'cached_tokens'], ['cache_read_input_tokens']]],
    ['output', [['output_tokens'], ['total_output_tokens'], ['completion_tokens']]],
    ['reasoning', [['output_tokens_details', 'reasoning_tokens'], ['total_thought_tokens'], ['completion_tokens_details', 'reasoning_tokens']]],
    ['total', [['total_tokens']]],
  ]
  const result: RawNumbers = {}
  for (const [name, paths] of fields) {
    const value = firstNumber(raw, paths)
    if (value !== undefined) result[name] = value
  }
  return result
}

export function tinyPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 40 >>\nstream\nBT /F1 18 Tf 20 50 Td (rill check) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SCHEMA = {
  type: 'object',
  properties: { word: { type: 'string' }, count: { type: 'integer' }, note: { type: 'string' } },
  required: ['word', 'count'],
  additionalProperties: false,
}

function prefixText(): string {
  const lines = ['You are a connectivity check for an automation app. Answer with one JSON object that matches the schema: set word to the word asked for and count to the number asked for. Leave note out.']
  for (let index = 1; index <= PREFIX_LINES; index += 1) lines.push(`Reference ${index}: the check word is rill, the check number is 3, and this line only pads the shared prefix so that it is long enough to be cached.`)
  return lines.join('\n')
}

const PREFIX = prefixText()
export const PREFIX_TOKENS = Math.ceil(PREFIX.length / CHARS_PER_TOKEN)

interface CallPlan {
  name: CheckCallName
  title: string
  inputTokens: number
  request: () => LlmRequest
}

function plans(): CallPlan[] {
  const system = [{ text: PREFIX, cache: true }]
  const base = { system, schema: SCHEMA, maxTokens: CHECK_MAX_TOKENS, effort: 'low' as const }
  const ask = 'Return the word "rill" and the count 3.'
  return [
    { name: 'text', title: 'text + schema with an optional field', inputTokens: PREFIX_TOKENS + 40, request: () => ({ ...base, messages: [{ role: 'user', content: ask }] }) },
    { name: 'repeat', title: 'the same call again, to see a cache read', inputTokens: PREFIX_TOKENS + 40, request: () => ({ ...base, messages: [{ role: 'user', content: ask }] }) },
    {
      name: 'image',
      title: 'image',
      inputTokens: PREFIX_TOKENS + IMAGE_TOKENS,
      request: () => ({ ...base, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG_PIXEL }, { type: 'text', text: ask }] }] }),
    },
    {
      name: 'pdf',
      title: 'PDF',
      inputTokens: PREFIX_TOKENS + PDF_TOKENS,
      request: () => ({ ...base, messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: tinyPdf().toString('base64') }, { type: 'text', text: ask }] }] }),
    },
  ]
}

function worstCaseOf(spec: string, plan: CallPlan): number | undefined {
  return estimateCallUsd(spec, plan.inputTokens, CHECK_MAX_TOKENS * softCapFactor(spec))
}

function typicalOf(spec: string, plan: CallPlan): number | undefined {
  return estimateCallUsd(spec, plan.inputTokens, 100)
}

const short = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > MAX_MEASURED ? `${flat.slice(0, MAX_MEASURED)}...` : flat
}

type Evaluator = (m: Measurements) => { status: LiveStatus; measured: string }

const unknown = (measured: string): { status: LiveStatus; measured: string } => ({ status: 'UNKNOWN', measured })

function describeError(record: CallRecord): string {
  return record.error === undefined ? (record.reason ?? 'not run') : `${record.error.kind}: ${short(record.error.message)}`
}

function viaCall(name: CheckCallName, passText: string): Evaluator {
  return (m) => {
    const record = m.calls[name]
    if (record.status === 'not-run') return unknown(`the ${name} call was not run: ${record.reason ?? ''}`.trim())
    if (record.status === 'error') return { status: 'FAIL', measured: describeError(record) }
    return record.dataValid === false ? { status: 'FAIL', measured: `the reply did not match the schema: ${short(JSON.stringify(record.data))}` } : { status: 'PASS', measured: passText }
  }
}

function rawOf(m: Measurements): { raw: unknown; numbers: RawNumbers } | undefined {
  for (const name of ['repeat', 'text'] as const) {
    const record = m.calls[name]
    if (record.status === 'ok' && record.raw !== undefined) return { raw: record.raw, numbers: rawUsageNumbers(record.raw) }
  }
  return undefined
}

const needsRaw = (run: (raw: unknown, numbers: RawNumbers, m: Measurements) => { status: LiveStatus; measured: string }): Evaluator => (m) => {
  const found = rawOf(m)
  return found === undefined ? unknown('no usage was read from a reply') : run(found.raw, found.numbers, m)
}

const cacheRead = (m: Measurements): number | undefined => (m.calls.repeat.status === 'ok' ? m.calls.repeat.usage?.cacheReadInputTokens : undefined)

function cacheCheck(failWhenNone: boolean): Evaluator {
  return (m) => {
    const read = cacheRead(m)
    if (read === undefined) return unknown('the repeated call did not run')
    if (read > 0) return { status: 'PASS', measured: `the repeated call read ${read} tokens from the cache (prefix of about ${m.prefixTokens} tokens)` }
    return failWhenNone
      ? { status: 'FAIL', measured: `the repeated call read no tokens from the cache (prefix of about ${m.prefixTokens} tokens)` }
      : unknown(`no cache read on the repeated call (prefix of about ${m.prefixTokens} tokens); the minimum or the time to live may be higher`)
  }
}

const cachedSubset: Evaluator = needsRaw((_raw, n) => {
  if (n.input === undefined || n.cached === undefined || n.cached === 0) return unknown('no cached tokens were reported, so the relation is not shown')
  return n.cached <= n.input
    ? { status: 'PASS', measured: `cached ${n.cached} of input ${n.input}: the cached tokens are part of the input` }
    : { status: 'FAIL', measured: `cached ${n.cached} is larger than input ${n.input}: the cached tokens are not part of the input` }
})

const outputTotal: Evaluator = needsRaw((_raw, n) => {
  if (n.total === undefined || n.input === undefined || n.output === undefined || n.reasoning === undefined || n.reasoning === 0) {
    return unknown('the reply reported no reasoning tokens, so the total is not shown')
  }
  const difference = n.total - n.input
  return difference === n.output + n.reasoning
    ? { status: 'PASS', measured: `total ${n.total} - input ${n.input} = ${difference} = output ${n.output} + reasoning ${n.reasoning}` }
    : { status: 'FAIL', measured: `total ${n.total} - input ${n.input} = ${difference}, but output ${n.output} + reasoning ${n.reasoning} = ${n.output + n.reasoning}` }
})

const thoughtsSeparate: Evaluator = needsRaw((_raw, n) => {
  if (n.total === undefined || n.input === undefined || n.output === undefined || n.reasoning === undefined) return unknown('the reply reported no thought tokens')
  const sum = n.input + n.output + n.reasoning
  return sum === n.total
    ? { status: 'PASS', measured: `input ${n.input} + output ${n.output} + thoughts ${n.reasoning} = total ${n.total}` }
    : { status: 'FAIL', measured: `input ${n.input} + output ${n.output} + thoughts ${n.reasoning} = ${sum}, total is ${n.total}` }
})

const reasoningInCompletion: Evaluator = needsRaw((_raw, n) => {
  if (n.reasoning === undefined || n.reasoning === 0 || n.output === undefined || n.input === undefined || n.total === undefined) {
    return unknown('the reply reported no reasoning tokens')
  }
  return n.output >= n.reasoning && n.total === n.input + n.output
    ? { status: 'PASS', measured: `completion ${n.output} >= reasoning ${n.reasoning} and total ${n.total} = prompt ${n.input} + completion ${n.output}` }
    : { status: 'FAIL', measured: `completion ${n.output}, reasoning ${n.reasoning}, prompt ${n.input}, total ${n.total}` }
})

const noCacheWriteField: Evaluator = needsRaw((raw) => {
  const text = JSON.stringify(raw)
  const found = /"[a-z_]*cache[a-z_]*(?:write|creat)[a-z_]*"/iu.exec(text)
  return found === null ? { status: 'PASS', measured: 'the usage object has no cache write field' } : { status: 'FAIL', measured: `the usage object has ${found[0]}` }
})

const servedModel: Evaluator = (m) => {
  const record = m.calls.text
  if (record.status !== 'ok') return unknown('the text call did not succeed')
  if (record.servedModel === undefined) return unknown('the reply named no model')
  return record.servedModel === m.requestedModel
    ? { status: 'PASS', measured: `the reply names ${record.servedModel}` }
    : { status: 'FAIL', measured: `asked for ${m.requestedModel}, the reply names ${record.servedModel}` }
}

const notStreamed: Evaluator = () => unknown('the calls of this check are below the streaming threshold, so no stream was read')

export const LIVE_EVALUATORS: Readonly<Record<string, Evaluator>> = {
  'pdf-schema-reasoning': viaCall('pdf', 'a PDF, a strict schema and reasoning effort worked together and the reply matched the schema'),
  'pdf-schema-reasoning-together': viaCall('pdf', 'a PDF, a response schema and thinking worked together and the reply matched the schema'),
  'schema-with-reasoning-pdf-and-streaming': viaCall('pdf', 'a schema, reasoning, a PDF and streaming worked together and the reply matched the schema'),
  'file-part-next-to-text': viaCall('pdf', 'a file part and a text part in one message were accepted'),
  'strict-false-optional-properties': viaCall('text', 'a schema with an optional property was accepted and the reply matched it'),
  'image-data-url': viaCall('image', 'an inline base64 PNG was accepted and the reply matched the schema'),
  'regional-availability': viaCall('text', 'the model answered from this key and region'),
  'interactions-default-schema': viaCall('text', 'the request without an Api-Revision header returned a reply the adapter could read'),
  'stream-text-location': viaCall('text', 'the adapter read the answer from the stream'),
  'terminal-event-shape': viaCall('text', 'the adapter read the answer from the terminal event'),
  'stream-terminal-event': notStreamed,
  'cache-hit': cacheCheck(true),
  'cache-minimum-and-ttl': cacheCheck(false),
  'implicit-cache-minimum-flash-lite': cacheCheck(false),
  'usage-cached-subset': cachedSubset,
  'usage-input-includes-cached': cachedSubset,
  'usage-output-total': outputTotal,
  'usage-thoughts-separate': thoughtsSeparate,
  'completion-tokens-include-reasoning': reasoningInCompletion,
  'cache-write-unreported': noCacheWriteField,
  'served-model-id': servedModel,
}

export function evaluateLiveChecks(checks: readonly LiveCheck[], measurements: Measurements): LiveResult[] {
  return checks.map((check) => {
    const evaluator = LIVE_EVALUATORS[check.id]
    const result = evaluator === undefined ? unknown('not measured by check-provider; verify it by hand') : evaluator(measurements)
    return { id: check.id, what: check.what, ...result }
  })
}

function notRunCalls(reason: string): Record<CheckCallName, CallRecord> {
  return Object.fromEntries(CHECK_CALL_NAMES.map((name) => [name, { name, status: 'not-run', reason }])) as Record<CheckCallName, CallRecord>
}

function isValid(data: unknown): boolean {
  if (!isRecord(data)) return false
  const { word, count, note } = data
  return typeof word === 'string' && typeof count === 'number' && Number.isInteger(count) && (note === undefined || typeof note === 'string') && Object.keys(data).every((key) => ['word', 'count', 'note'].includes(key))
}

function formatLive(results: readonly LiveResult[]): string[] {
  const lines: string[] = []
  for (const entry of results) {
    lines.push(`  ${entry.status.padEnd(7)} ${entry.id}: ${entry.measured}`)
    lines.push(`          ${entry.what}`)
  }
  return lines
}

function planLines(spec: string, label: string, plansList: readonly CallPlan[], reads: boolean): string[] {
  const lines = [`check-provider: ${spec} (${label}), prices as of ${PRICE_TABLE_AS_OF}`, `prefix: about ${PREFIX_TOKENS} tokens, longer than the cache minimums the vendor reports state (4096 tokens at most)`]
  plansList.forEach((plan, index) => {
    const prefix = `call ${index + 1} of ${plansList.length}: ${plan.title}`
    if (plan.name === 'pdf' && !reads) lines.push(`${prefix} (refused before any request: this model reads no PDF files; no cost)`)
    else lines.push(`${prefix} (typical ${money(typicalOf(spec, plan))}, worst case ${money(worstCaseOf(spec, plan))})`)
  })
  return lines
}

interface Charged {
  priced: number | undefined
  bodies: string[]
  model: string | null
  count: number
}

async function runCall(provider: LlmProvider, plan: CallPlan, drain: () => Charged): Promise<{ record: CallRecord; charged: Charged }> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_MAX_CALL_MS)
  try {
    const result = await provider.generate(plan.request(), { signal: controller.signal, timeoutMs: CHECK_MAX_CALL_MS })
    const charged = drain()
    return {
      charged,
      record: { name: plan.name, status: 'ok', data: result.data, dataValid: isValid(result.data), usage: result.usage, servedModel: charged.model ?? result.model, raw: charged.bodies.map(rawUsageOf).findLast((entry) => entry !== undefined), durationMs: Date.now() - started },
    }
  } catch (error) {
    const charged = drain()
    const llm = error instanceof LlmError ? error : undefined
    return {
      charged,
      record: {
        name: plan.name,
        status: 'error',
        error: { kind: llm?.kind ?? 'unknown', message: error instanceof Error ? error.message : String(error) },
        raw: charged.bodies.map(rawUsageOf).findLast((entry) => entry !== undefined),
        durationMs: Date.now() - started,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function checkProviderMain(argv: readonly string[], io: CliIo): Promise<number> {
  let secret = ''
  try {
    const config = parseCheckProviderArgs(argv)
    if (config.help) {
      io.stdout(CHECK_USAGE)
      return EXIT_OK
    }
    const spec = config.provider === 'anthropic' ? config.model : `${config.provider}:${config.model}`
    const descriptor = providerDescriptor(config.provider)
    const info = describeSpec(spec)
    secret = io.env[descriptor.keyEnv]?.trim() ?? ''
    if (priceFor(spec) === undefined) {
      io.stderr(`error: no price for ${spec}; the budget guard needs one\n`)
      return EXIT_ERROR
    }
    const reads = info.capabilities.documents !== 'none'
    const callPlans = plans()
    const lines = planLines(spec, descriptor.label, callPlans, reads)
    const worstTotal = callPlans.reduce((total, plan) => total + (plan.name === 'pdf' && !reads ? 0 : (worstCaseOf(spec, plan) ?? 0)), 0)
    if (!config.yes) {
      const empty: Measurements = { spec, requestedModel: modelIdOf(spec), prefixTokens: PREFIX_TOKENS, calls: notRunCalls('nothing was sent') }
      io.stdout(
        [
          ...lines,
          `worst case of all calls: ${money(worstTotal)}; budget ${money(config.budgetUsd)}${worstTotal > config.budgetUsd ? ' (the guard would stop before the last calls)' : ''}`,
          '',
          `live checks of the ${descriptor.label} adapter (${descriptor.liveChecks.length}):`,
          ...formatLive(evaluateLiveChecks(descriptor.liveChecks, empty)),
          '',
          `Nothing was sent. To run it for real (needs ${descriptor.keyEnv} in the environment):`,
          `  ${COMMAND} --provider ${config.provider} --model ${config.model} --yes${config.budgetUsd === CHECK_DEFAULT_BUDGET_USD ? '' : ` --budget-usd ${formatUsdPlain(config.budgetUsd)}`}`,
          '',
        ].join('\n'),
      )
      return EXIT_OK
    }
    if (secret === '') {
      io.stderr(`error: ${descriptor.keyEnv} is not set; --yes needs it in the environment\n`)
      return EXIT_ERROR
    }
    const firstWorst = worstCaseOf(spec, callPlans[0] as CallPlan) ?? 0
    if (config.budgetUsd < firstWorst) {
      io.stderr(`error: --budget-usd ${formatUsdPlain(config.budgetUsd)} is below the worst case of the first call (${money(firstWorst)}); raise it or pick a cheaper model\n`)
      return EXIT_ERROR
    }
    const endpoint = effectiveEndpoint(config.provider === 'anthropic' ? io.env : {})
    if (config.provider === 'anthropic' && !endpointCheck(config.allowBaseUrl, io, endpoint)) return EXIT_ERROR

    const bodies: string[] = []
    const inner: FetchFn = async (input, init) => {
      const response = await (io.checkProvider?.fetch ?? ((url, options) => globalThis.fetch(url, options)))(input, init)
      try {
        bodies.push(await response.clone().text())
      } catch {
        bodies.push('')
      }
      return response
    }
    const { provider, recorder } = createSpecProvider({ model: spec, apiKey: secret, maxTokens: CHECK_MAX_TOKENS, timeoutMs: CHECK_MAX_CALL_MS, baseURL: endpoint.baseURL, clock: io.now, fetch: inner })

    io.stdout(`${lines.join('\n')}\nbudget: ${money(config.budgetUsd)}; the guard stops before a call whose worst case does not fit\n\n`)
    const measurements: Measurements = { spec, requestedModel: modelIdOf(spec), prefixTokens: PREFIX_TOKENS, calls: notRunCalls('not reached') }
    let spent = 0
    let seenExchanges = 0
    let seenBodies = 0
    let authFailed = false
    const drain = (): Charged => {
      const exchanges = recorder.exchanges().slice(seenExchanges)
      seenExchanges += exchanges.length
      const taken = bodies.slice(seenBodies)
      seenBodies += taken.length
      let priced: number | undefined = 0
      for (const exchange of exchanges) priced = priced === undefined ? undefined : priced + (costUsd(spec, exchange.usage) ?? 0)
      return { priced, bodies: taken, model: exchanges.findLast((exchange) => exchange.model !== null)?.model ?? null, count: exchanges.length }
    }

    for (const [index, plan] of callPlans.entries()) {
      const title = `call ${index + 1} of ${callPlans.length}: ${plan.title}`
      if (authFailed) {
        measurements.calls[plan.name] = { name: plan.name, status: 'not-run', reason: 'the key was rejected' }
        continue
      }
      if (plan.name === 'pdf' && !reads) {
        const { record, charged } = await runCall(provider, plan, drain)
        measurements.calls[plan.name] = record
        spent += charged.priced ?? 0
        const refusedLocally = record.status === 'error' && charged.count === 0
        io.stdout(
          refusedLocally
            ? `${title}: refused before any request (${short(record.error?.message ?? '')})\n`
            : `${title}: ${record.status}${charged.count > 0 ? `; WARNING: ${plural(charged.count, 'request')} left although the model is declared to read no PDF` : ''}\n`,
        )
        continue
      }
      const worst = worstCaseOf(spec, plan) ?? 0
      if (spent + worst > config.budgetUsd + 1e-9) {
        const reason = `the budget (${money(config.budgetUsd)}) cannot cover the worst case of this call (${money(worst)}) after ${money(spent)} spent`
        measurements.calls[plan.name] = { name: plan.name, status: 'not-run', reason }
        io.stdout(`${title}: not run: ${reason}\n`)
        continue
      }
      const { record, charged } = await runCall(provider, plan, drain)
      measurements.calls[plan.name] = record
      spent += charged.priced ?? 0
      io.stdout(`${title}: ${record.status}${record.durationMs === undefined ? '' : `, ${record.durationMs} ms`}${record.error === undefined ? '' : ` (${describeError(record)})`}\n`)
      if (record.usage !== undefined) {
        io.stdout(`  adapter usage: input ${record.usage.inputTokens}, output ${record.usage.outputTokens}, cache read ${record.usage.cacheReadInputTokens}, cache write ${record.usage.cacheCreationInputTokens}\n`)
      }
      if (record.raw !== undefined) io.stdout(`  raw usage: ${short(JSON.stringify(record.raw))}\n`)
      if (record.data !== undefined) io.stdout(`  data: ${short(JSON.stringify(record.data))}\n`)
      if (record.error?.kind === 'auth') {
        authFailed = true
        io.stderr(`error: the API rejected the key of ${descriptor.label} (authentication failure); check ${descriptor.keyEnv} and the model access of the key\n`)
      }
    }

    const results = evaluateLiveChecks(descriptor.liveChecks, measurements)
    const count = (status: LiveStatus): number => results.filter((entry) => entry.status === status).length
    io.stdout(
      [
        '',
        descriptor.liveChecks.length === 0 ? 'live checks: the adapter declares none' : `live checks of the ${descriptor.label} adapter:`,
        ...formatLive(results),
        '',
        `summary: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('UNKNOWN')} UNKNOWN. spent ${money(spent)} of $${formatUsdPlain(config.budgetUsd)}.`,
        '',
      ].join('\n'),
    )
    return authFailed ? EXIT_ERROR : EXIT_OK
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${CHECK_USAGE}`)
      return EXIT_USAGE
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`error: ${secret === '' ? message : message.split(secret).join('[redacted]')}\n`)
    return EXIT_ERROR
  }
}
