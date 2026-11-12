import { inflateSync } from 'node:zlib'

export const MAX_PAGE_IMAGES = 50
const PAGE_OBJECT = /\/Type\s*\/Page(?![A-Za-z])/g
const OBJECT_STREAM = /\/Type\s*\/ObjStm(?![A-Za-z])/g
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

const countPageObjects = (text: string): number => text.match(PAGE_OBJECT)?.length ?? 0

function inflatedPageObjects(bytes: Buffer, text: string): number {
  let pages = 0
  OBJECT_STREAM.lastIndex = 0
  for (let match = OBJECT_STREAM.exec(text); match !== null; match = OBJECT_STREAM.exec(text)) {
    const keyword = text.indexOf('stream', match.index)
    if (keyword === -1) break
    let start = keyword + 'stream'.length
    if (text[start] === '\r') start += 1
    if (text[start] === '\n') start += 1
    const end = text.indexOf('endstream', start)
    if (end === -1) break
    try {
      pages += countPageObjects(inflateSync(bytes.subarray(start, end), { maxOutputLength: MAX_INFLATED_BYTES }).toString('latin1'))
    } catch {
      continue
    }
  }
  return pages
}

/** Page images Meta renders from a PDF; a file whose pages cannot be counted is assumed to have the maximum. */
export function pdfPageImages(base64: string): number {
  const bytes = Buffer.from(base64, 'base64')
  const text = bytes.toString('latin1')
  const pages = countPageObjects(text) + inflatedPageObjects(bytes, text)
  return pages === 0 ? MAX_PAGE_IMAGES : Math.min(pages, MAX_PAGE_IMAGES)
}
