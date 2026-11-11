import Type from 'typebox'
import { defineTrigger } from '../types'

export const folderWatchConfigSchema = Type.Object(
  {
    folder: Type.String({ minLength: 1 }),
    glob: Type.Optional(Type.String({ minLength: 1 })),
    pollMs: Type.Optional(Type.Integer({ minimum: 200, maximum: 60_000 })),
    stableMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
    includeExisting: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export type FolderWatchConfig = Type.Static<typeof folderWatchConfigSchema>

export const triggerFolderWatch = defineTrigger({
  type: 'trigger.folderWatch@1',
  title: 'Folder watch',
  description:
    'Starts the workflow for each new file in a folder once the file has stopped changing. Polls the folder; files already present when the workflow is first activated are skipped unless includeExisting is true.',
  configSchema: folderWatchConfigSchema,
  outputSchema: Type.Object({
    file: Type.String(),
    name: Type.String(),
    extension: Type.String(),
    bytes: Type.Integer(),
    modifiedAt: Type.String(),
  }),
  validate: (config) => {
    const glob = (config as FolderWatchConfig).glob ?? '*'
    return /[\\/]/.test(glob) ? ['glob must match file names only, without path separators'] : []
  },
})
