import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { extractText, getDocumentProxy } from 'unpdf'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIXTURES_DIR,
  FIXTURE_KINDS,
  GENERATOR_VERSION,
  MANIFEST_FILE,
  PNG_LAYOUT,
  assertGlyphCoverage,
  fixtureFile,
  fixtureRelativePath,
  generateFixtures,
  loadGlyphCoverage,
  loadManifest,
  planPdf,
  planPng,
  receiptLines,
  renderPng,
  uncoveredCharacters,
  type FixtureKind,
} from '../src/suites/extract/fixtures'
import { renderText } from '../src/suites/extract/render-text'
import { loadSeeds, type Seed } from '../src/suites/extract/seed'
import { fmtDate, fmtMoney, fmtNum, hasDateToken, hasNumberToken, normalizeSpace } from './extract-reference'

const drawn = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock('@napi-rs/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@napi-rs/canvas')>()
  return {
    ...actual,
    createCanvas: (width: number, height: number) => {
      const canvas = actual.createCanvas(width, height)
      const getContext = canvas.getContext.bind(canvas)
      canvas.getContext = ((type: '2d') => {
        const ctx = getContext(type)
        const fillText = ctx.fillText.bind(ctx)
        ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
          drawn.lines.push(text)
          if (maxWidth === undefined) fillText(text, x, y)
          else fillText(text, x, y, maxWidth)
        }
        return ctx
      }) as typeof canvas.getContext
      return canvas
    },
  }
})

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_BYTES = 3_932_160
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_EDGE = 1568
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const seeds = loadSeeds()
const manifest = loadManifest()
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const read = (seedId: string, kind: FixtureKind): Buffer => readFileSync(fixtureFile(seedId, kind))
const seedsById = new Map(seeds.map((seed) => [seed.id, seed]))
const seedOf = (id: string): Seed => {
  const seed = seedsById.get(id)
  if (!seed) throw new Error(`no seed ${id}`)
  return seed
}
const perSeed = seeds.map((seed) => [seed.id, seed] as const)

describe('fixture manifest', () => {
  it('records the generator version, the font and one entry per seed and kind', () => {
    expect(manifest.generatorVersion).toBe(GENERATOR_VERSION)
    const fontPackage = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@kfonts/d2coding/package.json'), 'utf8')) as {
      version: string
    }
    expect(manifest.font).toMatchObject({ package: '@kfonts/d2coding', version: fontPackage.version, license: 'OFL-1.1' })
    expect(manifest.files).toHaveLength(seeds.length * FIXTURE_KINDS.length)
    expect(manifest.files.map((entry) => [entry.seedId, entry.kind])).toEqual(
      seeds.flatMap((seed) => FIXTURE_KINDS.map((kind) => [seed.id, kind])),
    )
  })

  it.each(perSeed)('%s has all three files and they match the manifest', (id) => {
    for (const kind of FIXTURE_KINDS) {
      const entry = manifest.files.find((candidate) => candidate.seedId === id && candidate.kind === kind)
      expect(entry, `${id} ${kind} in the manifest`).toBeDefined()
      expect(entry?.path).toBe(fixtureRelativePath(id, kind))
      const data = read(id, kind)
      expect(data.length, `${id} ${kind} bytes`).toBe(entry?.bytes)
      expect(sha256(data), `${id} ${kind} sha256`).toBe(entry?.sha256)
    }
  })

  it('leaves no file on disk that the manifest does not list', () => {
    const onDisk = FIXTURE_KINDS.flatMap((kind) => readdirSync(join(FIXTURES_DIR, kind)).map((name) => `${kind}/${name}`)).sort()
    expect(onDisk).toEqual(manifest.files.map((entry) => entry.path).sort())
    expect(readdirSync(FIXTURES_DIR).sort()).toEqual([MANIFEST_FILE, ...FIXTURE_KINDS].sort())
  })
})

describe('file loader limits', () => {
  it.each(perSeed)('%s fits the llm.extract limits', (id) => {
    const text = read(id, 'text')
    const pdf = read(id, 'pdf')
    const png = read(id, 'png')
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    expect(pdf.length).toBeLessThan(MAX_DOCUMENT_BYTES)
    expect(png.length).toBeLessThan(MAX_IMAGE_BYTES)
    expect(pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true)
    expect(png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true)
  })

  it('keeps the whole fixture set under 4 MB', () => {
    const total = manifest.files.reduce((sum, entry) => sum + statSync(join(FIXTURES_DIR, entry.path)).size, 0)
    expect(total).toBeLessThan(MAX_TOTAL_BYTES)
  })
})

describe('text fixtures', () => {
  it.each(perSeed)('%s equals renderText byte for byte', (id, seed) => {
    expect(read(id, 'text').equals(Buffer.from(renderText(seed), 'utf8'))).toBe(true)
  })
})

describe('PDF text layer', () => {
  it.each(perSeed)('%s carries the expected values and the whole receipt text', async (id, seed) => {
    const pdf = await getDocumentProxy(new Uint8Array(read(id, 'pdf')))
    const { text, totalPages } = await extractText(pdf, { mergePages: true })
    const layer = normalizeSpace(text)
    const { amount, date, vendor } = seed.expected
    if (amount !== null) {
      const { numberFormat, currencySymbolPosition } = seed.render
      expect(hasNumberToken(layer, fmtNum(amount, numberFormat)), `amount ${fmtNum(amount, numberFormat)} in the text layer`).toBe(true)
      const money = normalizeSpace(fmtMoney(amount, seed.data.currency, numberFormat, currencySymbolPosition))
      expect(hasNumberToken(layer, money), `amount ${money} in the text layer`).toBe(true)
    }
    if (date !== null) {
      const printed = fmtDate(date, seed.render.dateFormat)
      expect(hasDateToken(layer, printed), `date ${printed} in the text layer`).toBe(true)
    }
    if (vendor !== null) expect(layer).toContain(normalizeSpace(vendor))
    expect(layer.replace(/\s+/g, ''), 'the text layer is the receipt text').toBe(renderText(seed).replace(/\s+/g, ''))
    expect(totalPages).toBe(planPdf(receiptLines(renderText(seed))).pages.length)
  })

  it('splits only the long receipt over several pages', () => {
    const pages = new Map(seeds.map((seed) => [seed.id, planPdf(receiptLines(renderText(seed))).pages.length]))
    expect(pages.get('tricky-ko-long-mart')).toBe(2)
    expect([...pages].filter(([, count]) => count !== 1).map(([id]) => id)).toEqual(['tricky-ko-long-mart'])
  })
})

describe('determinism', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('regenerates a Korean, an English and the long receipt byte for byte', async () => {
    const chosen = ['easy-ko-cafe-yeonnam', 'easy-en-coffee-us', 'tricky-ko-long-mart'].map(seedOf)
    const dir = mkdtempSync(join(tmpdir(), 'rill-fixtures-'))
    dirs.push(dir)
    const regenerated = await generateFixtures({ outDir: dir, seeds: chosen })
    expect(regenerated.files).toHaveLength(chosen.length * FIXTURE_KINDS.length)
    for (const entry of regenerated.files) {
      const committed = manifest.files.find((candidate) => candidate.path === entry.path)
      expect(entry, entry.path).toEqual(committed)
      expect(readFileSync(join(dir, entry.path)).equals(readFileSync(join(FIXTURES_DIR, entry.path))), entry.path).toBe(true)
    }
  })

  it('produces the same manifest when it runs twice', async () => {
    const chosen = [seedOf('easy-en-coffee-us')]
    const first = mkdtempSync(join(tmpdir(), 'rill-fixtures-'))
    const second = mkdtempSync(join(tmpdir(), 'rill-fixtures-'))
    dirs.push(first, second)
    await generateFixtures({ outDir: first, seeds: chosen })
    await generateFixtures({ outDir: second, seeds: chosen })
    expect(readFileSync(join(first, MANIFEST_FILE), 'utf8')).toBe(readFileSync(join(second, MANIFEST_FILE), 'utf8'))
  })
})

describe('glyph coverage', () => {
  it.each(perSeed)('%s only uses characters the fixture font can draw', async (_id, seed) => {
    expect(uncoveredCharacters(renderText(seed), await loadGlyphCoverage())).toEqual([])
  })

  it('covers the currency symbols and punctuation the seeds rely on', async () => {
    const coverage = await loadGlyphCoverage()
    for (const char of '₩£¥€$원円※') expect(coverage.has(char.codePointAt(0) ?? 0), char).toBe(true)
  })

  it('reports a character the font cannot draw', async () => {
    expect(uncoveredCharacters('ok \u{1F600} 원', await loadGlyphCoverage())).toEqual(['\u{1F600}'])
    await expect(assertGlyphCoverage('some-seed', 'total \u{1F600}')).rejects.toThrow(/some-seed: .*U\+1F600/)
  })

  it('makes the generator fail loudly on an uncovered character', async () => {
    const seed = structuredClone(seedOf('easy-en-coffee-us'))
    seed.data.vendor = 'Maple \u{1F600} Coffee'
    const dir = mkdtempSync(join(tmpdir(), 'rill-fixtures-'))
    try {
      await expect(generateFixtures({ outDir: dir, seeds: [seed] })).rejects.toThrow(/easy-en-coffee-us: .*U\+1F600/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PNG fixtures', () => {
  async function ink(png: Buffer): Promise<{ width: number; height: number; dark: number; levels: number }> {
    const image = await loadImage(png)
    const canvas = createCanvas(image.width, image.height)
    const g = canvas.getContext('2d')
    g.drawImage(image, 0, 0)
    const pixels = g.getImageData(0, 0, image.width, image.height).data
    const levels = new Set<number>()
    let dark = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = Math.round((pixels[i] ?? 0) * 0.299 + (pixels[i + 1] ?? 0) * 0.587 + (pixels[i + 2] ?? 0) * 0.114)
      levels.add(luminance)
      if (luminance < 128) dark += 1
    }
    return { width: image.width, height: image.height, dark, levels: levels.size }
  }

  it.each(perSeed)('%s has sane dimensions and visible ink (no OCR, so the pixels are not read back)', async (id, seed) => {
    const png = read(id, 'png')
    const plan = planPng(receiptLines(renderText(seed)))
    const { width, height, dark, levels } = await ink(png)
    expect({ width, height }).toEqual({ width: plan.width, height: plan.height })
    expect(width).toBeGreaterThanOrEqual(200)
    expect(width).toBeLessThanOrEqual(MAX_IMAGE_EDGE)
    expect(height).toBeLessThan(MAX_IMAGE_EDGE)
    const characters = [...renderText(seed)].filter((char) => char.trim() !== '').length
    const ratio = dark / (width * height)
    expect(ratio, 'ink ratio').toBeLessThan(0.2)
    expect(dark / Math.max(1, characters), 'dark pixels per drawn character').toBeGreaterThan(8)
    if (id !== 'nondoc-en-blank-page') expect(ratio, 'ink ratio').toBeGreaterThan(0.01)
    expect(levels, 'distinct luminance levels').toBeGreaterThan(2)
  })

  it('keeps the font readable except where a long receipt forces it smaller', () => {
    const sizes = new Map(seeds.map((seed) => [seed.id, planPng(receiptLines(renderText(seed))).fontSize]))
    const shrunk = [...sizes].filter(([, size]) => size < PNG_LAYOUT.fontSizes[0]).map(([id, size]) => [id, size])
    expect(shrunk).toEqual([
      ['tricky-ko-long-mart', 12],
      ['adv-en-reveal-system-prompt', 20],
    ])
  })

  describe('the lines drawn on the canvas', () => {
    beforeEach(() => {
      drawn.lines.length = 0
    })

    it.each(perSeed)('%s are the lines of the text fixture, in order', async (id) => {
      const lines = receiptLines(read(id, 'text').toString('utf8'))
      await renderPng(planPng(lines))
      expect(drawn.lines).toEqual(lines.filter((line) => line.length > 0))
    })
  })

  it('draws the same lines into the PDF pages as the text fixture holds', () => {
    for (const [id] of perSeed) {
      const lines = receiptLines(read(id, 'text').toString('utf8'))
      expect(planPdf(lines).pages.flat(), id).toEqual(lines)
    }
  })
})
