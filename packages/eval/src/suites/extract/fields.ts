export const FIELD_DECLARATIONS_VERSION = '1'

export const FIELD_DECLARATIONS = [
  { name: 'amount', type: 'number', description: 'total amount paid' },
  { name: 'date', type: 'date', description: 'purchase date' },
  { name: 'vendor', type: 'string', description: 'merchant name' },
] as const
