import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import Type from 'typebox'
import { assertPathAllowed } from '../guard'
import { defineAction } from '../types'

const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.log': 'text/plain',
}

const BINARY_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const DEFAULT_MAX_BYTES = 1_048_576

export const fileRead = defineAction({
  type: 'file.read@1',
  title: 'Read file',
  description: 'Reads a file. Text files return their text; other files return metadata so a later node can use the path.',
  sideEffect: 'none',
  configSchema: Type.Object(
    {
      path: Type.String({ minLength: 1 }),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_485_760 })),
    },
    { additionalProperties: false },
  ),
  outputSchema: Type.Object({
    path: Type.String(),
    name: Type.String(),
    extension: Type.String(),
    bytes: Type.Integer(),
    kind: Type.Union([Type.Literal('text'), Type.Literal('binary')]),
    mime: Type.String(),
    text: Type.Optional(Type.String()),
  }),
  execute: async (config, ctx) => {
    const path = assertPathAllowed(config.path, ctx.allowedRoots)
    const stats = statSync(path)
    if (!stats.isFile()) throw new Error(`not a file: ${config.path}`)
    const extension = extname(path).toLowerCase()
    const base = { path, name: basename(path), extension, bytes: stats.size }
    const textMime = TEXT_TYPES[extension]
    if (textMime === undefined) {
      return { ...base, kind: 'binary' as const, mime: BINARY_TYPES[extension] ?? 'application/octet-stream' }
    }
    const limit = config.maxBytes ?? DEFAULT_MAX_BYTES
    if (stats.size > limit) throw new Error(`file is larger than maxBytes (${stats.size} > ${limit}): ${config.path}`)
    return { ...base, kind: 'text' as const, mime: textMime, text: readFileSync(path, 'utf8') }
  },
})
