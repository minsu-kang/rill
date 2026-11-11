export const FIELD_DECLARATIONS_VERSION = '1'

export const FIELD_VARIANT_NAMES = ['default', 'strict'] as const
export type FieldVariant = (typeof FIELD_VARIANT_NAMES)[number]

export const FIELD_VARIANTS = {
  default: [
    { name: 'amount', type: 'number', description: 'total amount paid' },
    { name: 'date', type: 'date', description: 'purchase date' },
    { name: 'vendor', type: 'string', description: 'merchant name' },
  ],
  strict: [
    {
      name: 'amount',
      type: 'number',
      description: 'total amount paid, as printed on a receipt or invoice; null if the document is not a receipt or invoice',
    },
    {
      name: 'date',
      type: 'date',
      description: 'purchase date printed on a receipt or invoice; null if the document is not a receipt or invoice or shows no purchase date',
    },
    {
      name: 'vendor',
      type: 'string',
      description: 'merchant name printed on a receipt or invoice; null if the document is not a receipt or invoice',
    },
  ],
} as const

export const FIELD_DECLARATIONS = FIELD_VARIANTS.default
