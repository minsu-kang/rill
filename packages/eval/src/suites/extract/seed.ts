import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Type from 'typebox'
import Value from 'typebox/value'
import {
  CURRENCY_CODES,
  DATE_FORMATS,
  INJECTION_POSITIONS,
  LABEL_KEYS,
  LANGUAGES,
  NUMBER_FORMAT_NAMES,
  OMITTABLE,
  SYMBOL_POSITIONS,
  TEMPLATES,
  type LabelKey,
} from './render-text'

export const DIFFICULTIES = ['easy', 'tricky', 'missing', 'adversarial', 'nondoc'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

export const SEEDS_PATH = fileURLToPath(new URL('./data/seeds.json', import.meta.url))

const nullable = <T extends Type.TSchema>(schema: T) => Type.Union([schema, Type.Null()])

const lineItemSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    qty: Type.Integer({ minimum: 1 }),
    unitPrice: Type.Number(),
  },
  { additionalProperties: false },
)

const dataSchema = Type.Object(
  {
    vendor: nullable(Type.String({ minLength: 1 })),
    lines: Type.Array(lineItemSchema),
    subtotal: nullable(Type.Number()),
    tax: nullable(Type.Number()),
    tip: nullable(Type.Number()),
    discount: nullable(Type.Number()),
    total: nullable(Type.Number()),
    currency: Type.Enum(CURRENCY_CODES),
    date: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    time: nullable(Type.String({ minLength: 1 })),
    paymentMethod: nullable(Type.String({ minLength: 1 })),
    change: nullable(Type.Number()),
    body: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
)

const labelsSchema = Type.Object(
  Object.fromEntries(LABEL_KEYS.map((key) => [key, Type.Optional(Type.String())])) as Record<
    LabelKey,
    Type.TOptional<Type.TString>
  >,
  { additionalProperties: false },
)

const slotLines = Type.Optional(Type.Array(Type.String()))

const extraSchema = Type.Object(
  { header: slotLines, meta: slotLines, beforeTotals: slotLines, afterTotals: slotLines, footer: slotLines },
  { additionalProperties: false },
)

const tornSchema = Type.Union([
  Type.Object({ edge: Type.Literal('bottom'), keepItems: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ edge: Type.Literal('top'), dropItems: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
])

const renderSchema = Type.Object(
  {
    dateFormat: Type.Enum(DATE_FORMATS),
    numberFormat: Type.Enum(NUMBER_FORMAT_NAMES),
    currencySymbolPosition: Type.Enum(SYMBOL_POSITIONS),
    labels: labelsSchema,
    taxInclusive: Type.Optional(Type.Boolean()),
    dateHint: Type.Optional(Type.String({ minLength: 1 })),
    omit: Type.Optional(Type.Array(Type.Enum(OMITTABLE))),
    torn: Type.Optional(tornSchema),
    extra: Type.Optional(extraSchema),
    injectionPosition: Type.Optional(Type.Enum(INJECTION_POSITIONS)),
  },
  { additionalProperties: false },
)

const expectedSchema = Type.Object(
  {
    amount: nullable(Type.Number()),
    date: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    vendor: nullable(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

export const seedSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
    tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    difficulty: Type.Enum(DIFFICULTIES),
    language: Type.Enum(LANGUAGES),
    template: Type.Enum(TEMPLATES),
    data: dataSchema,
    render: renderSchema,
    injection: nullable(Type.String({ minLength: 1 })),
    expected: expectedSchema,
    vendorAliases: Type.Array(Type.String({ minLength: 4 })),
    why: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const seedsSchema = Type.Array(seedSchema)

export type Seed = Type.Static<typeof seedSchema>
export type SeedData = Seed['data']
export type SeedRender = Seed['render']
export type SeedExpected = Seed['expected']
export type LineItem = SeedData['lines'][number]

export function parseSeeds(input: unknown): Seed[] {
  if (Value.Check(seedsSchema, input)) return input
  const errors = [...Value.Errors(seedsSchema, input)]
    .slice(0, 10)
    .map((error) => `${error.instancePath || '/'}: ${error.message}`)
  throw new Error(`invalid extraction seeds:\n${errors.join('\n')}`)
}

export function loadSeeds(): Seed[] {
  return parseSeeds(JSON.parse(readFileSync(SEEDS_PATH, 'utf8')))
}
