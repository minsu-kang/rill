import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ColorRule {
  selector: string
  text: string[]
  background: string[]
}

const TEXT = /(?:^|[;\s])color:\s*var\((--[a-zA-Z0-9-]+)\)/g
const BACKGROUND = /(?:^|[;\s])background(?:-color)?:\s*var\((--[a-zA-Z0-9-]+)\)/g

export function colorRules(css: string): ColorRule[] {
  const rules: ColorRule[] = []
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2]!
    const text = [...body.matchAll(TEXT)].map((found) => found[1]!)
    const background = [...body.matchAll(BACKGROUND)].map((found) => found[1]!)
    if (text.length > 0 || background.length > 0) rules.push({ selector: match[1]!.trim().replace(/\s+/g, ' '), text, background })
  }
  return rules
}

export function moduleColorRules(dir: string): Array<ColorRule & { file: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return moduleColorRules(path)
    return entry.name.endsWith('.module.css') ? colorRules(readFileSync(path, 'utf8')).map((rule) => ({ ...rule, file: entry.name })) : []
  })
}
