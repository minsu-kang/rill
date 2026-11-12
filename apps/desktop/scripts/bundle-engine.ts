import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const DEFAULT_OUT_FILE = join(REPO_ROOT, 'apps/desktop/dist/engine/rill-engine.mjs')

const REQUIRE_BANNER = "import { createRequire as __rillCreateRequire } from 'node:module';\nconst require = __rillCreateRequire(import.meta.url);"

export interface BundleResult {
  outFile: string
  inputs: string[]
}

export async function bundleEngine(options: { outFile?: string } = {}): Promise<BundleResult> {
  const outFile = options.outFile ?? DEFAULT_OUT_FILE
  mkdirSync(dirname(outFile), { recursive: true })
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: ['packages/engine/src/cli.ts'],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: REQUIRE_BANNER },
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
  })
  return { outFile, inputs: Object.keys(result.metafile.inputs) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
  const result = await bundleEngine(outFile === undefined ? {} : { outFile })
  console.log(`engine bundle written to ${result.outFile} (${result.inputs.length} modules)`)
}
