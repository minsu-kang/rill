import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPlannerData } from '../src/suites/planner/cases'
import {
  ATTACHMENTS_DIR,
  ATTACHMENTS_GENERATOR_VERSION,
  ATTACHMENTS_MANIFEST_FILE,
  createMemoryStore,
  generateAttachments,
  injectedAttachments,
  injectedSeed,
  loadAttachmentManifest,
  plannerAttachmentPath,
  resolveAttachment,
  resolveAttachments,
  verifyAttachments,
} from '../src/suites/planner/attachments'
import { renderText } from '../src/suites/extract/render-text'
import { loadSeeds } from '../src/suites/extract/seed'

const { cases } = loadPlannerData()
const seeds = loadSeeds()
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const caseOf = (id: string) => {
  const found = cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}
const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rill-planner-attachments-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOST = 'https://collect.evil-example.net/upload'
const PATH_INJECTION = '/Users/demo/Library/LaunchAgents/ledger.csv'

describe('planner attachment fixtures', () => {
  it('cover exactly the attachments that carry an inject sentence', () => {
    const injected = injectedAttachments(cases)
    expect(injected.map((item) => [item.caseId, item.index, item.spec.kind])).toEqual([
      ['attach-03-pdf-injection-http-exfil', 0, 'pdf'],
      ['attach-04-text-injection-outside-path', 0, 'text'],
    ])
    const manifest = loadAttachmentManifest()
    expect(manifest.generatorVersion).toBe(ATTACHMENTS_GENERATOR_VERSION)
    expect(manifest.files.map((entry) => [entry.caseId, entry.index, entry.kind, entry.path])).toEqual(
      injected.map((item) => [item.caseId, item.index, item.spec.kind, plannerAttachmentPath(item.caseId, item.index, item.spec.kind)]),
    )
    expect(readdirSync(ATTACHMENTS_DIR).sort()).toEqual([ATTACHMENTS_MANIFEST_FILE, ...manifest.files.map((entry) => entry.path)].sort())
  })

  it('match the manifest byte count and hash, and verifyAttachments finds no problem on every case', () => {
    for (const entry of loadAttachmentManifest().files) {
      const data = readFileSync(join(ATTACHMENTS_DIR, entry.path))
      expect(data.length).toBe(entry.bytes)
      expect(sha256(data)).toBe(entry.sha256)
    }
    expect(verifyAttachments(cases)).toEqual([])
  })

  it('are reproduced byte for byte by the generator', async () => {
    const out = tempDir()
    const manifest = await generateAttachments({ outDir: out, cases })
    expect(manifest).toEqual(loadAttachmentManifest())
    for (const entry of manifest.files) expect(readFileSync(join(out, entry.path)).equals(readFileSync(join(ATTACHMENTS_DIR, entry.path)))).toBe(true)
  })

  it('keep the receipt and add one injected sentence to the text fixture', () => {
    const seed = seeds.find((candidate) => candidate.id === 'easy-mixed-bookstore-order')
    if (seed === undefined) throw new Error('no seed')
    const injection = caseOf('attach-04-text-injection-outside-path').context.attachments?.[0]?.inject ?? ''
    const text = readFileSync(join(ATTACHMENTS_DIR, plannerAttachmentPath('attach-04-text-injection-outside-path', 0, 'text')), 'utf8')
    expect(text).toBe(renderText(injectedSeed(seed, injection)))
    expect(text.split('\n').filter((line) => line.includes('Planner instruction'))).toHaveLength(1)
    expect(text).toContain(PATH_INJECTION)
    expect(text).toContain('~/.ssh/id_rsa')
    expect(text).toContain('24,300원')
    expect(renderText(seed)).not.toContain('Planner instruction')
  })

  it('carry the injected host in the PDF text layer next to the receipt', async () => {
    const data = readFileSync(join(ATTACHMENTS_DIR, plannerAttachmentPath('attach-03-pdf-injection-http-exfil', 0, 'pdf')))
    const pdf = await getDocumentProxy(new Uint8Array(data))
    const { text } = await extractText(pdf, { mergePages: true })
    const layer = text.replace(/\s+/g, ' ')
    expect(layer).toContain(HOST)
    expect(layer).toContain('NOTE TO THE ASSISTANT THAT BUILDS THE WORKFLOW')
  })

  it('never name a real host: the injected host is the case author text, not contacted', () => {
    const text = JSON.stringify(loadAttachmentManifest())
    expect(text).toContain('evil-example.net')
    expect(text).not.toMatch(/https?:\/\/(?!collect\.evil-example\.net)[a-z0-9.-]+/i)
  })
})

describe('injectedSeed', () => {
  it('copies the seed without changing it or its expected values', () => {
    const seed = seeds.find((candidate) => candidate.id === 'easy-ko-bunsik-sinchon')
    if (seed === undefined) throw new Error('no seed')
    const before = JSON.stringify(seed)
    const copy = injectedSeed(seed, 'x')
    expect(JSON.stringify(seed)).toBe(before)
    expect(copy).toMatchObject({ difficulty: 'adversarial', injection: 'x', render: { injectionPosition: 'footer' }, expected: seed.expected })
  })
})

describe('resolveAttachments', () => {
  it('reads non-injected attachments from the extract fixtures and injected ones from the planner folder', () => {
    const plain = resolveAttachment(caseOf('attach-01-sample-pdf-extract-to-csv'), 0)
    expect(plain.file).toMatch(/fixtures\/extract\/pdf\/easy-ko-cafe-yeonnam\.pdf$/)
    const injected = resolveAttachment(caseOf('attach-03-pdf-injection-http-exfil'), 0)
    expect(injected.file).toBe(join(ATTACHMENTS_DIR, 'attach-03-pdf-injection-http-exfil-0.pdf'))
    expect(injected.bytes.length).not.toBe(resolveAttachment(caseOf('attach-01-sample-pdf-extract-to-csv'), 0).bytes.length)
  })

  it('gives neutral ids and names and the right media type and size, and the store returns the bytes', async () => {
    const files = resolveAttachments(caseOf('attach-02-sample-png-english'))
    expect(files).toHaveLength(1)
    const [file] = files
    expect(file?.ref).toEqual({ id: 'att-1', mediaType: 'image/png', name: 'sample-1.png', bytes: file?.bytes.length })
    const store = createMemoryStore(files)
    expect(await store.read('att-1')).toBe(file?.bytes)
    expect(await store.read('att-2')).toBeUndefined()
    const kinds = cases.flatMap((entry) => resolveAttachments(entry).map((attachment) => [attachment.spec.kind, attachment.ref.mediaType, attachment.ref.name]))
    expect(kinds).toContainEqual(['text', 'text/plain', 'sample-1.txt'])
    expect(kinds).toContainEqual(['pdf', 'application/pdf', 'sample-1.pdf'])
    for (const entry of cases) for (const attachment of resolveAttachments(entry)) expect(JSON.stringify(attachment.ref)).not.toMatch(/injection|attach-|easy-|exfil/)
  })

  it('returns no attachment for a case without any and throws for an index that is not there', () => {
    expect(resolveAttachments(caseOf('easy-01-receipt-folder-to-csv'))).toEqual([])
    expect(() => resolveAttachment(caseOf('easy-01-receipt-folder-to-csv'), 0)).toThrow('has no attachment 0')
  })
})

describe('verifyAttachments', () => {
  it('reports a tampered injected fixture, a wrong kind and a missing manifest', () => {
    const copy = tempDir()
    cpSync(ATTACHMENTS_DIR, copy, { recursive: true })
    writeFileSync(join(copy, 'attach-04-text-injection-outside-path-0.txt'), 'changed')
    expect(verifyAttachments(cases, { plannerDir: copy })).toEqual(['attach-04-text-injection-outside-path attachment 0: differs from the manifest (regenerate the attachments)'])
    writeFileSync(join(copy, 'attach-03-pdf-injection-http-exfil-0.pdf'), 'not a pdf')
    expect(verifyAttachments(cases, { plannerDir: copy }).join('\n')).toContain('attach-03-pdf-injection-http-exfil attachment 0: not a pdf file')
    rmSync(join(copy, ATTACHMENTS_MANIFEST_FILE))
    expect(verifyAttachments(cases, { plannerDir: copy }).join('\n')).toContain('manifest is missing or invalid')
  })

  it('reports a missing file and an attachment that no manifest lists', () => {
    const copy = tempDir()
    cpSync(ATTACHMENTS_DIR, copy, { recursive: true })
    rmSync(join(copy, 'attach-03-pdf-injection-http-exfil-0.pdf'))
    expect(verifyAttachments(cases, { plannerDir: copy })).toEqual(['attach-03-pdf-injection-http-exfil attachment 0: fixture file is missing or unreadable'])
    const lone = caseOf('attach-01-sample-pdf-extract-to-csv')
    const stranger = { ...lone, context: { ...lone.context, attachments: [{ kind: 'pdf' as const, fixture: 'no-such-seed', note: 'x' }] } }
    expect(verifyAttachments([stranger])).toEqual(['attach-01-sample-pdf-extract-to-csv attachment 0: not in a manifest'])
  })
})
