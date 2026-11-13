import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEMO_FOLDER_NAME = 'Rill-Demo'
export const SAMPLE_PDF = 'receipt-cafe.pdf'
export const DEFAULT_FIXTURES_DIR = resolve(import.meta.dirname, '../../../packages/eval/fixtures/extract')

export interface DemoFile {
  seedId: string
  kind: 'pdf' | 'png' | 'text'
  name: string
}

export const DEMO_FILES: readonly DemoFile[] = [
  { seedId: 'easy-ko-cafe-yeonnam', kind: 'pdf', name: SAMPLE_PDF },
  { seedId: 'easy-ko-bunsik-sinchon', kind: 'png', name: 'receipt-snack-bar.png' },
  { seedId: 'easy-ko-pharmacy-hangul-date', kind: 'text', name: 'receipt-pharmacy.txt' },
]

export interface PrepareDemoResult {
  folder: string
  receiptsDir: string
  inboxDir: string
  copied: string[]
  skipped: string[]
}

export class DemoPrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoPrepareError'
  }
}

interface ManifestEntry {
  seedId: string
  kind: string
  path: string
  bytes: number
  sha256: string
}

interface Source {
  file: DemoFile
  bytes: Buffer
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.seedId === 'string' &&
    typeof entry.kind === 'string' &&
    typeof entry.path === 'string' &&
    typeof entry.bytes === 'number' &&
    typeof entry.sha256 === 'string'
  )
}

function readManifest(fixturesDir: string): ManifestEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'))
  } catch {
    throw new DemoPrepareError(`cannot read the fixture manifest in ${fixturesDir}`)
  }
  const files = (parsed as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) throw new DemoPrepareError('the fixture manifest has no file list')
  return files.filter(isManifestEntry)
}

function loadSources(fixturesDir: string): Source[] {
  const root = resolve(fixturesDir)
  const entries = readManifest(root)
  return DEMO_FILES.map((file) => {
    const entry = entries.find((candidate) => candidate.seedId === file.seedId && candidate.kind === file.kind)
    if (entry === undefined) throw new DemoPrepareError(`the manifest has no ${file.kind} fixture for ${file.seedId}`)
    const source = resolve(root, entry.path)
    const inside = relative(root, source)
    if (inside.startsWith('..') || isAbsolute(inside)) throw new DemoPrepareError(`fixture path leaves the fixture folder: ${entry.path}`)
    const stats = lstatSync(source, { throwIfNoEntry: false })
    if (stats === undefined || !stats.isFile()) throw new DemoPrepareError(`fixture is missing or not a plain file: ${entry.path}`)
    const bytes = readFileSync(source)
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new DemoPrepareError(`fixture does not match the manifest: ${entry.path}`)
    }
    return { file, bytes }
  })
}

function assertNoLinks(path: string): void {
  const absolute = resolve(path)
  const { root } = parse(absolute)
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter((segment) => segment !== '')) {
    current = join(current, part)
    const stats = lstatSync(current, { throwIfNoEntry: false })
    if (stats === undefined) return
    if (stats.isSymbolicLink()) {
      throw new DemoPrepareError(`${current} is a symbolic link. Use a real folder path. Nothing was written.`)
    }
    if (!stats.isDirectory()) throw new DemoPrepareError(`${current} is not a folder. Nothing was written.`)
  }
}

function ensureFolder(path: string): void {
  assertNoLinks(path)
  mkdirSync(path, { recursive: true, mode: 0o755 })
  assertNoLinks(path)
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) throw new DemoPrepareError(`could not create ${path}`)
}

function writeNew(path: string, bytes: Buffer): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, bytes)
  } catch (error) {
    closeSync(fd)
    rmSync(path, { force: true })
    throw error
  }
  closeSync(fd)
  return true
}

export function prepareDemo(options: { home?: string; fixturesDir?: string } = {}): PrepareDemoResult {
  const home = options.home ?? homedir()
  if (!isAbsolute(home)) throw new DemoPrepareError('the home folder must be an absolute path')
  assertNoLinks(home)
  if (lstatSync(home, { throwIfNoEntry: false }) === undefined) throw new DemoPrepareError(`the home folder does not exist: ${home}`)
  const sources = loadSources(options.fixturesDir ?? DEFAULT_FIXTURES_DIR)
  const folder = join(resolve(home), DEMO_FOLDER_NAME)
  const receiptsDir = join(folder, 'Receipts')
  const inboxDir = join(folder, 'Inbox')
  assertNoLinks(receiptsDir)
  assertNoLinks(inboxDir)
  ensureFolder(receiptsDir)
  ensureFolder(inboxDir)
  const copied: string[] = []
  const skipped: string[] = []
  for (const { file, bytes } of sources) {
    if (writeNew(join(receiptsDir, file.name), bytes)) copied.push(file.name)
    else skipped.push(file.name)
  }
  return { folder, receiptsDir, inboxDir, copied, skipped }
}

export function formatNextSteps(result: PrepareDemoResult): string[] {
  const lines = [`Demo folder: ${result.folder}`, `  Receipts (synthetic sample receipts): ${result.receiptsDir}`, `  Inbox (empty, the folder the workflow will watch): ${result.inboxDir}`]
  if (result.copied.length > 0) lines.push(`Copied: ${result.copied.join(', ')}`)
  if (result.skipped.length > 0) lines.push(`Already there, left untouched: ${result.skipped.join(', ')}`)
  lines.push(
    '',
    'Next steps',
    '  1. Start Rill: pnpm --filter @rill/desktop dev (or open the installed app).',
    `  2. Settings, Folders: add ${result.folder}`,
    '  3. Settings, Keys: add a key for your model provider.',
    '     Settings, Connections: add a Slack connection named demo-slack (a bot token, see docs/demo.md).',
    '  4. In the chat, send the request in docs/demo.md that names the folder, the CSV file and the connection.',
    '     If the planner asks questions anyway, answer with:',
    `       folder      ${result.inboxDir}`,
    `       CSV file    ${join(result.folder, 'ledger.csv')}`,
    '       connection  demo-slack',
    '  5. Deploy it, run a dry run, activate it, then copy a receipt into the Inbox:',
    `       ${join(result.receiptsDir, SAMPLE_PDF)}`,
    'The full script, with the texts to type, is in docs/demo.md.',
  )
  return lines
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(formatNextSteps(prepareDemo()).join('\n'))
  } catch (error) {
    console.error(`demo:prepare stopped: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
