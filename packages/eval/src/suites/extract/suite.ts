import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmProvider, LlmRequest } from '@rill/llm'
import { llmExtract, type NodeContext } from '@rill/nodes-core'
import Type from 'typebox'
import Value from 'typebox/value'
import { summarizeRequest, type SentRequest } from '../../sent'
import { FIELD_NAMES, scoreFields, type Expected } from '../../score'
import type { CaseScore, EvalCase, Suite } from '../../suite'
import { FIELD_DECLARATIONS, FIELD_DECLARATIONS_VERSION } from './fields'
import { FIXTURES_DIR, FIXTURE_KINDS, MANIFEST_FILE, fixtureFile, loadManifest, type FixtureKind } from './fixtures'
import { INJECTION_TARGETS, injectionComplied } from './injection'
import { SEEDS_PATH, parseSeeds, type Seed } from './seed'

export const SUITE_NAME = 'extract'
export const SUITE_NUMBER = 1
export const TEXT_CHARS_PER_TOKEN = 3.5
export const TEXT_OVERHEAD_TOKENS = 400
export const PDF_INPUT_TOKENS = 2400
export const PNG_INPUT_TOKENS = 2000

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 3_932_160
const MAX_PDF_BYTES = 20 * 1024 * 1024

const ADVERSARIAL = 'adversarial'
const VERSION_HASH_LENGTH = 12

const outputSchema = Type.Object(
  {
    amount: Type.Union([Type.Number(), Type.Null()]),
    date: Type.Union([Type.String(), Type.Null()]),
    vendor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)

export type ExtractOutput = Type.Static<typeof outputSchema>

export interface ExtractCase extends EvalCase {
  seed: string
  kind: FixtureKind
  file: string
  expected: Expected
  vendorAliases: readonly string[]
}

export interface ExtractSuiteOptions {
  kinds?: readonly FixtureKind[]
  only?: string | readonly string[]
  fixturesDir?: string
  seedsPath?: string
}

export interface ExtractSuite extends Suite<ExtractCase, ExtractOutput> {
  fixturesDir: string
}

const sentRequests = new WeakMap<ExtractOutput, SentRequest>()

export function sentRequestOf(output: ExtractOutput): SentRequest | undefined {
  return sentRequests.get(output)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function selectSeeds(seeds: readonly Seed[], only: string | readonly string[] | undefined): Seed[] {
  if (only === undefined) return [...seeds]
  const ids = seeds.map((seed) => seed.id)
  if (typeof only !== 'string') {
    const unknown = only.filter((id) => !ids.includes(id))
    if (unknown.length > 0) throw new Error(`unknown seed id: ${unknown.join(', ')}`)
    return seeds.filter((seed) => only.includes(seed.id))
  }
  const exact = seeds.filter((seed) => seed.id === only)
  const picked = exact.length > 0 ? exact : seeds.filter((seed) => seed.id.includes(only))
  if (picked.length === 0) throw new Error(`no seed id contains "${only}"`)
  return picked
}

function tapProvider(provider: LlmProvider, onRequest: (request: LlmRequest) => void): LlmProvider {
  return {
    name: provider.name,
    generate: (request, options) => {
      onRequest(request)
      return provider.generate(request, options)
    },
  }
}

function nodeContext(testCase: ExtractCase, fixturesDir: string, llm: LlmProvider): NodeContext {
  const runId = `eval:${testCase.id}`
  return {
    runId,
    nodeId: 'extract',
    attempt: 1,
    dryRun: false,
    idempotencyKey: `${runId}:extract`,
    journal: { get: () => undefined, put: () => undefined },
    sleep: () => Promise.resolve(),
    allowedRoots: [fixturesDir],
    connections: { get: () => undefined },
    llm,
  }
}

export function createExtractSuite(options: ExtractSuiteOptions = {}): ExtractSuite {
  const fixturesDir = options.fixturesDir ?? FIXTURES_DIR
  const kinds = options.kinds ?? FIXTURE_KINDS
  if (kinds.length === 0 || new Set(kinds).size !== kinds.length) throw new Error('kinds must be a non-empty list without duplicates')
  const seedsPath = options.seedsPath ?? SEEDS_PATH
  const seedsBytes = readFileSync(seedsPath)
  const manifestBytes = readFileSync(join(fixturesDir, MANIFEST_FILE))
  const allSeeds = parseSeeds(JSON.parse(seedsBytes.toString('utf8')))
  const manifest = loadManifest(fixturesDir)
  const seeds = selectSeeds(allSeeds, options.only)
  for (const seed of seeds) {
    if (seed.difficulty === ADVERSARIAL && INJECTION_TARGETS[seed.id] === undefined) {
      throw new Error(`adversarial seed ${seed.id} has no entry in INJECTION_TARGETS`)
    }
    for (const kind of kinds) {
      if (!manifest.files.some((entry) => entry.seedId === seed.id && entry.kind === kind)) {
        throw new Error(`the fixture manifest has no ${kind} file for seed ${seed.id}`)
      }
    }
  }
  const version = [
    `${SUITE_NUMBER}.${FIELD_DECLARATIONS_VERSION}`,
    sha256(seedsBytes).slice(0, VERSION_HASH_LENGTH),
    sha256(manifestBytes).slice(0, VERSION_HASH_LENGTH),
  ].join('-')
  const cases: ExtractCase[] = seeds.flatMap((seed) =>
    kinds.map(
      (kind): ExtractCase => ({
        id: `${seed.id}:${kind}`,
        group: seed.id,
        category: seed.difficulty,
        tags: [...seed.tags],
        kind,
        seed: seed.id,
        file: fixtureFile(seed.id, kind, fixturesDir),
        expected: { amount: seed.expected.amount, date: seed.expected.date, vendor: seed.expected.vendor },
        vendorAliases: [...seed.vendorAliases],
      }),
    ),
  )
  const characters = new Map<string, number>()
  const textCharacters = (file: string): number => {
    const known = characters.get(file)
    if (known !== undefined) return known
    const count = readFileSync(file, 'utf8').length
    characters.set(file, count)
    return count
  }

  return {
    name: SUITE_NAME,
    version,
    fixturesDir,
    fields: FIELD_NAMES,
    cases: () => cases,
    run: async (testCase, ctx) => {
      let sent: LlmRequest | undefined
      const llm = tapProvider(ctx.provider, (request) => {
        sent = request
      })
      const reply = await llmExtract.execute(
        { file: testCase.file, fields: FIELD_DECLARATIONS.map((field) => ({ ...field })) },
        nodeContext(testCase, fixturesDir, llm),
      )
      if (!Value.Check(outputSchema, reply)) throw new Error('llm.extract returned an unexpected output shape')
      const output: ExtractOutput = { amount: reply.amount, date: reply.date, vendor: reply.vendor }
      if (sent !== undefined) sentRequests.set(output, summarizeRequest(sent))
      return output
    },
    score: (testCase, output): CaseScore => {
      const result = scoreFields({ expected: testCase.expected, output, vendorAliases: testCase.vendorAliases })
      const extra: Record<string, number> = {}
      if (testCase.category === ADVERSARIAL) {
        const target = INJECTION_TARGETS[testCase.seed]
        if (target === undefined) throw new Error(`adversarial seed ${testCase.seed} has no entry in INJECTION_TARGETS`)
        extra['inject_ok'] = injectionComplied(target, output) ? 0 : 1
      }
      return {
        status: result.status,
        outcomes: result.outcomes,
        extra,
        tags: Object.fromEntries(FIELD_NAMES.map((field) => [field, result.fields[field].tags])),
      }
    },
    estimateInputTokens: (testCase) => {
      if (testCase.kind === 'pdf') return PDF_INPUT_TOKENS
      if (testCase.kind === 'png') return PNG_INPUT_TOKENS
      return Math.ceil(textCharacters(testCase.file) / TEXT_CHARS_PER_TOKEN) + TEXT_OVERHEAD_TOKENS
    },
  }
}

const SIZE_LIMITS: Record<FixtureKind, number> = { text: MAX_TEXT_BYTES, pdf: MAX_PDF_BYTES, png: MAX_IMAGE_BYTES }

export function verifyFixtures(suite: ExtractSuite): string[] {
  const manifest = loadManifest(suite.fixturesDir)
  const problems: string[] = []
  for (const testCase of suite.cases()) {
    const entry = manifest.files.find((candidate) => candidate.seedId === testCase.seed && candidate.kind === testCase.kind)
    if (entry === undefined) {
      problems.push(`${testCase.id}: not in the fixture manifest`)
      continue
    }
    let bytes: Buffer
    try {
      if (statSync(testCase.file).size > SIZE_LIMITS[testCase.kind]) {
        problems.push(`${testCase.id}: larger than the ${testCase.kind} limit of the llm.extract node`)
        continue
      }
      bytes = readFileSync(testCase.file)
    } catch {
      problems.push(`${testCase.id}: fixture file is missing or unreadable`)
      continue
    }
    if (sha256(bytes) !== entry.sha256) problems.push(`${testCase.id}: fixture differs from the manifest (regenerate the fixtures)`)
  }
  return problems
}
