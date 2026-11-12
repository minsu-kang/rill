import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type TokenBlock = Map<string, string>

export const TOKENS_PATH = join(import.meta.dirname, '../src/theme/tokens.css')

export function readTokenBlocks(): Map<string, TokenBlock> {
  const css = readFileSync(TOKENS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = new Map<string, TokenBlock>()
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    const block = blocks.get(selector) ?? new Map<string, string>()
    for (const declaration of match[2]!.split(';')) {
      const separator = declaration.indexOf(':')
      if (separator < 0) continue
      const name = declaration.slice(0, separator).trim()
      if (name.startsWith('--')) block.set(name, declaration.slice(separator + 1).trim())
    }
    blocks.set(selector, block)
  }
  return blocks
}
