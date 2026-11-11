import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Type from 'typebox'
import Value from 'typebox/value'
import { displayWidth, renderText } from './render-text'
import { loadSeeds, type Seed } from './seed'

export const FIXTURE_KINDS = ['text', 'pdf', 'png'] as const
export type FixtureKind = (typeof FIXTURE_KINDS)[number]

export const FIXTURE_EXTENSIONS: Record<FixtureKind, string> = { text: 'txt', pdf: 'pdf', png: 'png' }

export const GENERATOR_VERSION = '1'
export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/extract/', import.meta.url))
export const MANIFEST_FILE = 'manifest.json'

export const PDF_LAYOUT = {
  fontSize: 9,
  lineHeight: 12,
  margin: 14,
  minWidth: 226,
  maxPageHeight: 842,
} as const

export const PNG_LAYOUT = {
  fontSizes: [24, 22, 20, 18, 16, 14, 12, 10, 8],
  lineHeightRatio: 1.2,
  paddingRatio: 0.9,
  baselineRatio: 0.91,
  maxEdge: 1560,
  paper: '#fbfaf6',
  ink: '#111111',
} as const

const FONT_PACKAGE = '@kfonts/d2coding'
const FONT_FILE = `${FONT_PACKAGE}/src/D2Coding.ttf`
const CANVAS_FAMILY = 'RillReceiptMono'
const FIXED_DATE = new Date('2026-01-01T00:00:00Z')

const manifestEntrySchema = Type.Object(
  {
    seedId: Type.String({ minLength: 1 }),
    kind: Type.Enum(FIXTURE_KINDS),
    path: Type.String({ minLength: 1 }),
    bytes: Type.Integer({ minimum: 1 }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  },
  { additionalProperties: false },
)

export const manifestSchema = Type.Object(
  {
    generatorVersion: Type.String({ minLength: 1 }),
    font: Type.Object(
      { package: Type.String(), version: Type.String(), license: Type.String(), file: Type.String() },
      { additionalProperties: false },
    ),
    files: Type.Array(manifestEntrySchema),
  },
  { additionalProperties: false },
)

export type ManifestEntry = Type.Static<typeof manifestEntrySchema>
export type FixtureManifest = Type.Static<typeof manifestSchema>

export interface PdfPlan {
  width: number
  height: number
  fontSize: number
  lineHeight: number
  margin: number
  pages: string[][]
}

export interface PngPlan {
  width: number
  height: number
  fontSize: number
  lineHeight: number
  padding: number
  baseline: number
  lines: string[]
}

export interface GlyphCoverage {
  has: (codePoint: number) => boolean
}

export function fixtureRelativePath(seedId: string, kind: FixtureKind): string {
  return `${kind}/${seedId}.${FIXTURE_EXTENSIONS[kind]}`
}

export function fixtureFile(seedId: string, kind: FixtureKind, dir: string = FIXTURES_DIR): string {
  return join(dir, fixtureRelativePath(seedId, kind))
}

export function loadManifest(dir: string = FIXTURES_DIR): FixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
  if (!Value.Check(manifestSchema, parsed)) throw new Error(`invalid fixture manifest in ${dir}`)
  return parsed
}

export function receiptLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function maxColumns(lines: readonly string[]): number {
  return Math.max(1, ...lines.map(displayWidth))
}

export function planPdf(lines: readonly string[]): PdfPlan {
  const { fontSize, lineHeight, margin, minWidth, maxPageHeight } = PDF_LAYOUT
  const width = Math.max(minWidth, 2 * margin + maxColumns(lines) * (fontSize / 2))
  const perPage = Math.floor((maxPageHeight - 2 * margin) / lineHeight)
  const pages: string[][] = []
  for (let start = 0; start < Math.max(1, lines.length); start += perPage) pages.push(lines.slice(start, start + perPage))
  const rows = pages.length === 1 ? lines.length : perPage
  return { width, height: 2 * margin + Math.max(1, rows) * lineHeight, fontSize, lineHeight, margin, pages }
}

export function planPng(lines: readonly string[]): PngPlan {
  const { fontSizes, lineHeightRatio, paddingRatio, baselineRatio, maxEdge } = PNG_LAYOUT
  const columns = maxColumns(lines)
  for (const fontSize of fontSizes) {
    const lineHeight = Math.round(fontSize * lineHeightRatio)
    const padding = Math.round(fontSize * paddingRatio)
    const width = 2 * padding + columns * (fontSize / 2)
    const height = 2 * padding + Math.max(1, lines.length) * lineHeight
    if (width <= maxEdge && height <= maxEdge) {
      return { width, height, fontSize, lineHeight, padding, baseline: Math.round(fontSize * baselineRatio), lines: [...lines] }
    }
  }
  throw new Error(`a receipt of ${lines.length} lines and ${columns} columns does not fit ${maxEdge}px at the smallest font`)
}

function fontPath(): string {
  return createRequire(import.meta.url).resolve(FONT_FILE)
}

function fontInfo(): FixtureManifest['font'] {
  const pkg: unknown = JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`${FONT_PACKAGE}/package.json`), 'utf8'))
  const version = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'version') : undefined
  if (typeof version !== 'string') throw new Error(`cannot read the version of ${FONT_PACKAGE}`)
  return { package: FONT_PACKAGE, version, license: 'OFL-1.1', file: 'src/D2Coding.ttf' }
}

let glyphCoverage: Promise<GlyphCoverage> | undefined

export function loadGlyphCoverage(): Promise<GlyphCoverage> {
  glyphCoverage ??= (async () => {
    const { default: PDFDocument } = await import('pdfkit')
    const doc = new PDFDocument({ autoFirstPage: false })
    doc.font(readFileSync(fontPath()))
    const embedded: unknown = Reflect.get(doc, '_font')
    const fontkitFont: unknown = typeof embedded === 'object' && embedded !== null ? Reflect.get(embedded, 'font') : undefined
    const hasGlyph: unknown =
      typeof fontkitFont === 'object' && fontkitFont !== null ? Reflect.get(fontkitFont, 'hasGlyphForCodePoint') : undefined
    if (typeof hasGlyph !== 'function') throw new Error('pdfkit no longer exposes its fontkit font; update the glyph coverage check')
    return { has: (codePoint: number) => Reflect.apply(hasGlyph, fontkitFont, [codePoint]) === true }
  })()
  return glyphCoverage
}

export function uncoveredCharacters(text: string, coverage: GlyphCoverage): string[] {
  const missing = new Set<string>()
  for (const char of text) {
    if (char === '\n') continue
    if (!coverage.has(char.codePointAt(0) ?? 0)) missing.add(char)
  }
  return [...missing]
}

export function describeCodePoints(chars: readonly string[]): string {
  return chars.map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(char)}`).join(', ')
}

export async function assertGlyphCoverage(label: string, text: string): Promise<void> {
  const missing = uncoveredCharacters(text, await loadGlyphCoverage())
  if (missing.length > 0) throw new Error(`${label}: the fixture font has no glyph for ${describeCodePoints(missing)}`)
}

export async function renderPdf(plan: PdfPlan): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit')
  const doc = new PDFDocument({
    size: [plan.width, plan.height],
    margin: 0,
    autoFirstPage: false,
    info: { Producer: 'rill-eval', Creator: 'rill-eval', CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
  })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', resolve)
    doc.on('error', reject)
  })
  doc.font(readFileSync(fontPath())).fontSize(plan.fontSize)
  for (const page of plan.pages) {
    doc.addPage({ size: [plan.width, plan.height], margin: 0 })
    page.forEach((line, index) => {
      if (line.length > 0) doc.text(line, plan.margin, plan.margin + index * plan.lineHeight, { lineBreak: false })
    })
  }
  doc.end()
  await finished
  return Buffer.concat(chunks)
}

export async function renderPng(plan: PngPlan): Promise<Buffer> {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas')
  if (!GlobalFonts.has(CANVAS_FAMILY) && !GlobalFonts.registerFromPath(fontPath(), CANVAS_FAMILY)) {
    throw new Error(`@napi-rs/canvas could not register ${FONT_FILE}`)
  }
  const canvas = createCanvas(plan.width, plan.height)
  const g = canvas.getContext('2d')
  g.fillStyle = PNG_LAYOUT.paper
  g.fillRect(0, 0, plan.width, plan.height)
  g.fillStyle = PNG_LAYOUT.ink
  g.font = `${plan.fontSize}px ${CANVAS_FAMILY}`
  g.textBaseline = 'alphabetic'
  plan.lines.forEach((line, index) => {
    if (line.length > 0) g.fillText(line, plan.padding, plan.padding + index * plan.lineHeight + plan.baseline)
  })
  return canvas.toBuffer('image/png')
}

export interface RenderedFixture {
  kind: FixtureKind
  data: Buffer
}

export async function renderFixtures(seed: Seed): Promise<RenderedFixture[]> {
  const text = renderText(seed)
  await assertGlyphCoverage(seed.id, text)
  const lines = receiptLines(text)
  return [
    { kind: 'text', data: Buffer.from(text, 'utf8') },
    { kind: 'pdf', data: await renderPdf(planPdf(lines)) },
    { kind: 'png', data: await renderPng(planPng(lines)) },
  ]
}

export interface GenerateOptions {
  outDir?: string
  seeds?: readonly Seed[]
}

export async function generateFixtures({ outDir = FIXTURES_DIR, seeds = loadSeeds() }: GenerateOptions = {}): Promise<FixtureManifest> {
  for (const kind of FIXTURE_KINDS) {
    rmSync(join(outDir, kind), { recursive: true, force: true })
    mkdirSync(join(outDir, kind), { recursive: true })
  }
  const files: ManifestEntry[] = []
  for (const seed of seeds) {
    for (const { kind, data } of await renderFixtures(seed)) {
      const path = fixtureRelativePath(seed.id, kind)
      writeFileSync(join(outDir, path), data)
      files.push({ seedId: seed.id, kind, path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
    }
  }
  const manifest: FixtureManifest = { generatorVersion: GENERATOR_VERSION, font: fontInfo(), files }
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
