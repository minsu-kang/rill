import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MAX_PAGE_IMAGES, pdfPageImages } from '../src/meta/pdf-pages'

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64')
const page = (index: number) => `${index + 10} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`
const plain = (pages: number) => b64(`%PDF-1.4\n2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n${Array.from({ length: pages }, (_, index) => page(index)).join('')}%%EOF`)

function objectStream(pages: number, options: { eol?: string; filter?: boolean } = {}): Buffer {
  const objects = Buffer.from(Array.from({ length: pages }, (_, index) => `<< /Type /Page /Parent 2 0 R /Index ${index} >>`).join('\n'))
  const content = options.filter === false ? objects : deflateSync(objects)
  const eol = options.eol ?? '\n'
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n7 0 obj\n<< /Type /ObjStm /N ${pages} /First 0 /Filter /FlateDecode /Length ${content.length} >>\nstream${eol}`),
    content,
    Buffer.from(`\nendstream\nendobj\n%%EOF`),
  ])
}

describe('pdfPageImages', () => {
  it('counts page objects and not the page tree node', () => {
    expect(pdfPageImages(plain(1))).toBe(1)
    expect(pdfPageImages(plain(7))).toBe(7)
  })

  it('reads names written without a space and ignores other names that start with Page', () => {
    expect(pdfPageImages(b64('%PDF-1.4\n<</Type/Page>>\n<</Type/Page>>\n<</Type/PageLabels>>\n<</Type /Pages /Count 9>>'))).toBe(2)
  })

  it('stops at fifty pages, since Meta renders no more', () => {
    expect(MAX_PAGE_IMAGES).toBe(50)
    expect(pdfPageImages(plain(49))).toBe(49)
    expect(pdfPageImages(plain(50))).toBe(50)
    expect(pdfPageImages(plain(51))).toBe(50)
    expect(pdfPageImages(plain(400))).toBe(50)
  })

  it('finds pages inside compressed object streams, for each kind of line ending after the stream keyword', () => {
    expect(pdfPageImages(b64(objectStream(5)))).toBe(5)
    expect(pdfPageImages(b64(objectStream(5, { eol: '\r\n' })))).toBe(5)
    expect(pdfPageImages(b64(objectStream(70)))).toBe(50)
  })

  it('adds pages found in plain text and in object streams, and counts an object stream that is not compressed only once', () => {
    const mixed = Buffer.concat([Buffer.from(Buffer.from(plain(3), 'base64')), objectStream(4)])
    expect(pdfPageImages(b64(mixed))).toBe(7)
    expect(pdfPageImages(b64(objectStream(4, { filter: false })))).toBe(4)
  })

  it('counts several object streams', () => {
    expect(pdfPageImages(b64(Buffer.concat([objectStream(3), objectStream(2)])))).toBe(5)
  })

  it('treats a file with no countable page as the largest case, never as zero', () => {
    expect(pdfPageImages(b64('%PDF-1.4 rill conformance'))).toBe(50)
    expect(pdfPageImages('')).toBe(50)
    expect(pdfPageImages(b64('not a pdf at all'))).toBe(50)
  })

  it('survives an object stream that cannot be read, and keeps what it could count', () => {
    const broken = Buffer.from('%PDF-1.5\n7 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\nthis is not zlib data\nendstream\nendobj\n')
    expect(pdfPageImages(b64(broken))).toBe(50)
    expect(pdfPageImages(b64(Buffer.concat([Buffer.from(Buffer.from(plain(2), 'base64')), broken])))).toBe(2)
    expect(pdfPageImages(b64('%PDF-1.5\n<< /Type /ObjStm >>\nstream'))).toBe(50)
    expect(pdfPageImages(b64('%PDF-1.5\n<< /Type /ObjStm >>\nstream\nabc'))).toBe(50)
  })

  it('gives up on a stream that inflates past its limit, so its pages count as unknown', () => {
    const bomb = deflateSync(Buffer.concat([Buffer.from('<< /Type /Page >>'.repeat(3)), Buffer.alloc(70_000_000)]))
    const file = Buffer.concat([Buffer.from('%PDF-1.5\n7 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n'), bomb, Buffer.from('\nendstream\nendobj\n')])
    expect(pdfPageImages(b64(file))).toBe(50)
  })

  it('draws the inflate limit at 64 MiB: a stream just under it is read, one just over it is not', () => {
    const MIB64 = 64 * 1024 * 1024
    const wrap = (inflated: number) => {
      const text = '<< /Type /Page >>'.repeat(3)
      const data = deflateSync(Buffer.concat([Buffer.from(text), Buffer.alloc(inflated - text.length)]))
      return b64(Buffer.concat([Buffer.from('%PDF-1.5\n7 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n'), data, Buffer.from('\nendstream\nendobj\n')]))
    }
    expect(pdfPageImages(wrap(MIB64 - 1000))).toBe(3)
    expect(pdfPageImages(wrap(MIB64 + 10_000))).toBe(50)
  })

  it('does not take an object whose type only starts with ObjStm for an object stream', () => {
    const objects = deflateSync(Buffer.from('<< /Type /Page >>'.repeat(3)))
    const decoy = Buffer.concat([Buffer.from('%PDF-1.5\n7 0 obj\n<< /Type /ObjStmX /Filter /FlateDecode >>\nstream\n'), objects, Buffer.from('\nendstream\nendobj\n')])
    expect(pdfPageImages(b64(decoy))).toBe(50)
  })

  it('goes on to the next object stream after one that cannot be read', () => {
    const broken = Buffer.from('%PDF-1.5\n7 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\nthis is not zlib data\nendstream\nendobj\n')
    expect(pdfPageImages(b64(Buffer.concat([broken, objectStream(3)])))).toBe(3)
  })
})
