import type { AttachmentPort } from '../../chat/Composer'
import type { HostApi } from '../../shared/host-api'

export function createAttachmentPort(host: Pick<HostApi, 'attachments'>): AttachmentPort {
  return {
    async add(file) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      return host.attachments.addFromBytes({ name: file.name, bytes })
    },
  }
}
