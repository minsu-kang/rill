import Type from 'typebox'
import { IdSchema } from './plan'

export const MEMORY_MAX_ITEMS = 20
export const MEMORY_MAX_CHARS = 300
export const MEMORY_MAX_INPUT_CHARS = 2000

export const MemoryItemSchema = Type.Object(
  {
    id: IdSchema,
    text: Type.String({ minLength: 1, maxLength: MEMORY_MAX_CHARS }),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
)

export type MemoryItem = Type.Static<typeof MemoryItemSchema>
