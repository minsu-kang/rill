import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentRef, AttachmentStore } from '@rill/planner'
import Type from 'typebox'
import Value from 'typebox/value'
import { FIXTURES_DIR, assertGlyphCoverage, loadManifest, planPdf, planPng, receiptLines, renderPdf, renderPng } from '../extract/fixtures'
import { renderText } from '../extract/render-text'
import { loadSeeds, type Seed } from '../extract/seed'
import { DATA_DIR } from './cases'
import { ATTACHMENT_KINDS, type AttachmentKind, type AttachmentSpec, type CaseSpec } from './schema'

export const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments')
export const ATTACHMENTS_MANIFEST_FILE = 'manifest.json'
export const ATTACHMENTS_GENERATOR_VERSION = '1'

const INJECTION_SLOT = 'footer'
const MAX_BYTES: Readonly<Record<AttachmentKind, number>> = { text: 1024 * 1024, pdf: 20 * 1024 * 1024, png: 3_932_160 }
const EXTENSIONS: Readonly<Record<AttachmentKind, string>> = { text: 'txt', pdf: 'pdf', png: 'png' }
const MEDIA_TYPES = { text: 'text/plain', pdf: 'application/pdf', png: 'image/png' } as const
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const entrySchema = Type.Object(
  {
    caseId: Type.String({ minLength: 1 }),
    index: Type.Integer({ minimum: 0 }),
    seedId: Type.String({ minLength: 1 }),
    kind: Type.Enum(ATTACHMENT_KINDS),
    path: Type.String({ minLength: 1 }),
    bytes: Type.Integer({ minimum: 1 }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    inject: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const manifestSchema = Type.Object(
  { generatorVersion: Type.String({ minLength: 1 }), files: Type.Array(entrySchema) },
  { additionalProperties: false },
)

export type AttachmentManifestEntry = Type.Static<typeof entrySchema>
export type AttachmentManifest = Type.Static<typeof manifestSchema>

export interface InjectedAttachment {
  caseId: string
  index: number
  spec: AttachmentSpec
  inject: string
}

export interface ResolvedAttachment {
  ref: AttachmentRef
  bytes: Uint8Array
  spec: AttachmentSpec
  file: string
}

export interface ResolveOptions {
  extractDir?: string
  plannerDir?: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function plannerAttachmentPath(caseId: string, index: number, kind: AttachmentKind): string {
  return `${caseId}-${index}.${EXTENSIONS[kind]}`
}

export function injectedAttachments(cases: readonly CaseSpec[]): InjectedAttachment[] {
  return cases.flatMap((testCase) =>
    (testCase.context.attachments ?? []).flatMap((spec, index) =>
      spec.inject === undefined ? [] : [{ caseId: testCase.id, index, spec, inject: spec.inject }],
    ),
  )
}

export function injectedSeed(seed: Seed, inject: string): Seed {
  return { ...seed, difficulty: 'adversarial', injection: inject, render: { ...seed.render, injectionPosition: INJECTION_SLOT } }
}

export async function renderAttachment(seed: Seed, kind: AttachmentKind): Promise<Buffer> {
  const text = renderText(seed)
  if (kind === 'text') return Buffer.from(text, 'utf8')
  await assertGlyphCoverage(seed.id, text)
  const lines = receiptLines(text)
  return kind === 'pdf' ? renderPdf(planPdf(lines)) : renderPng(planPng(lines))
}

export interface GenerateAttachmentsOptions {
  outDir?: string
  cases: readonly CaseSpec[]
  seeds?: readonly Seed[]
}

export async function generateAttachments({ outDir = ATTACHMENTS_DIR, cases, seeds = loadSeeds() }: GenerateAttachmentsOptions): Promise<AttachmentManifest> {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const files: AttachmentManifestEntry[] = []
  for (const item of injectedAttachments(cases)) {
    const seed = seeds.find((candidate) => candidate.id === item.spec.fixture)
    if (seed === undefined) throw new Error(`${item.caseId}: fixture ${item.spec.fixture} is not a seed id`)
    const data = await renderAttachment(injectedSeed(seed, item.inject), item.spec.kind)
    const path = plannerAttachmentPath(item.caseId, item.index, item.spec.kind)
    writeFileSync(join(outDir, path), data)
    files.push({ caseId: item.caseId, index: item.index, seedId: seed.id, kind: item.spec.kind, path, bytes: data.length, sha256: sha256(data), inject: item.inject })
  }
  const manifest: AttachmentManifest = { generatorVersion: ATTACHMENTS_GENERATOR_VERSION, files }
  writeFileSync(join(outDir, ATTACHMENTS_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function loadAttachmentManifest(dir: string = ATTACHMENTS_DIR): AttachmentManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, ATTACHMENTS_MANIFEST_FILE), 'utf8'))
  if (!Value.Check(manifestSchema, parsed)) throw new Error(`invalid planner attachment manifest in ${dir}`)
  return parsed
}

export function resolveAttachment(testCase: CaseSpec, index: number, options: ResolveOptions = {}): ResolvedAttachment {
  const spec = testCase.context.attachments?.[index]
  if (spec === undefined) throw new Error(`${testCase.id} has no attachment ${index}`)
  let file: string
  if (spec.inject === undefined) {
    const entry = loadManifest(options.extractDir ?? FIXTURES_DIR).files.find((candidate) => candidate.seedId === spec.fixture && candidate.kind === spec.kind)
    if (entry === undefined) throw new Error(`${testCase.id}: no ${spec.kind} fixture for ${spec.fixture} in the extract manifest`)
    file = join(options.extractDir ?? FIXTURES_DIR, entry.path)
  } else {
    file = join(options.plannerDir ?? ATTACHMENTS_DIR, plannerAttachmentPath(testCase.id, index, spec.kind))
  }
  const bytes = new Uint8Array(readFileSync(file))
  const ref: AttachmentRef = {
    id: `att-${index + 1}`,
    mediaType: MEDIA_TYPES[spec.kind],
    name: `sample-${index + 1}.${EXTENSIONS[spec.kind]}`,
    bytes: bytes.length,
  }
  return { ref, bytes, spec, file }
}

export function resolveAttachments(testCase: CaseSpec, options: ResolveOptions = {}): ResolvedAttachment[] {
  return (testCase.context.attachments ?? []).map((_spec, index) => resolveAttachment(testCase, index, options))
}

export function createMemoryStore(files: readonly ResolvedAttachment[]): AttachmentStore {
  const byId = new Map(files.map((file) => [file.ref.id, file.bytes]))
  return { read: (id) => Promise.resolve(byId.get(id)) }
}

function hasMagic(bytes: Uint8Array, kind: AttachmentKind): boolean {
  if (kind === 'text') return true
  const magic = kind === 'pdf' ? PDF_MAGIC : PNG_MAGIC
  return Buffer.from(bytes.subarray(0, magic.length)).equals(magic)
}

export function verifyAttachments(cases: readonly CaseSpec[], options: ResolveOptions = {}): string[] {
  const problems: string[] = []
  const plannerDir = options.plannerDir ?? ATTACHMENTS_DIR
  let manifest: AttachmentManifest | undefined
  try {
    manifest = loadAttachmentManifest(plannerDir)
  } catch {
    problems.push(`the planner attachment manifest is missing or invalid in ${plannerDir} (run generate-planner-attachments)`)
  }
  let extract: ReturnType<typeof loadManifest> | undefined
  try {
    extract = loadManifest(options.extractDir ?? FIXTURES_DIR)
  } catch {
    problems.push('the extract fixture manifest is missing or invalid')
  }
  for (const testCase of cases) {
    (testCase.context.attachments ?? []).forEach((spec, index) => {
      const label = `${testCase.id} attachment ${index}`
      let expected: string | undefined
      if (spec.inject === undefined) expected = extract?.files.find((candidate) => candidate.seedId === spec.fixture && candidate.kind === spec.kind)?.sha256
      else expected = manifest?.files.find((candidate) => candidate.caseId === testCase.id && candidate.index === index)?.sha256
      if (expected === undefined) return void problems.push(`${label}: not in a manifest`)
      let resolved: ResolvedAttachment
      try {
        resolved = resolveAttachment(testCase, index, options)
      } catch {
        return void problems.push(`${label}: fixture file is missing or unreadable`)
      }
      if (statSync(resolved.file).size > MAX_BYTES[spec.kind]) problems.push(`${label}: larger than the ${spec.kind} limit`)
      if (!hasMagic(resolved.bytes, spec.kind)) problems.push(`${label}: not a ${spec.kind} file`)
      if (sha256(resolved.bytes) !== expected) problems.push(`${label}: differs from the manifest (regenerate the attachments)`)
    })
  }
  return problems
}
