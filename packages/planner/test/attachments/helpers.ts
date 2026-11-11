import type { AttachmentStore } from '../../src/ports'
import type { AttachmentMediaType, AttachmentRef } from '../../src/types'

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of png')])
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
export const GIF = Buffer.from('GIF89a rest')
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])
export const PDF = Buffer.from('%PDF-1.4 fake receipt')

export function storeOf(files: Record<string, Uint8Array>): AttachmentStore {
  return { read: async (id) => (Object.hasOwn(files, id) ? files[id] : undefined) }
}

export function refOf(id: string, mediaType: AttachmentMediaType, name = `${id}.bin`, bytes = 1): AttachmentRef {
  return { id, mediaType, name, bytes }
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function counterHex(): (bytes: number) => string {
  let n = 0
  return (bytes) => {
    n += 1
    return n.toString(16).padStart(bytes * 2, '0')
  }
}
