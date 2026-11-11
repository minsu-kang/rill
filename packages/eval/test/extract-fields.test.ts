import { llmExtract } from '@rill/nodes-core'
import type { LlmRequest } from '@rill/llm'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { oracleProvider } from '../src/suites/extract/baselines'
import { FIELD_DECLARATIONS, FIELD_VARIANTS, FIELD_VARIANT_NAMES } from '../src/suites/extract/fields'
import { createExtractSuite, extractVersions } from '../src/suites/extract/suite'
import { main, parseCli, commandLine, type CliIo } from '../src/cli'

describe('field variants', () => {
  it('declares the same three fields in every variant and keeps the default wording', () => {
    expect(FIELD_VARIANT_NAMES).toEqual(['default', 'strict'])
    expect(FIELD_DECLARATIONS).toBe(FIELD_VARIANTS.default)
    expect(FIELD_VARIANTS.default.map((field) => field.description)).toEqual(['total amount paid', 'purchase date', 'merchant name'])
    for (const name of FIELD_VARIANT_NAMES) {
      expect(FIELD_VARIANTS[name].map((field) => [field.name, field.type])).toEqual([
        ['amount', 'number'],
        ['date', 'date'],
        ['vendor', 'string'],
      ])
    }
  })

  it('makes every strict description say what to return for a document that is not a receipt or invoice', () => {
    for (const field of FIELD_VARIANTS.strict) expect(field.description).toMatch(/null if the document is not a receipt or invoice/u)
    expect(FIELD_VARIANTS.strict[1].description).toContain('shows no purchase date')
  })

  it('is accepted by the llm.extract config schema (description length limit included)', () => {
    for (const name of FIELD_VARIANT_NAMES) {
      const config = { file: 'x.txt', fields: FIELD_VARIANTS[name].map((field) => ({ ...field })) }
      expect(Value.Check(llmExtract.configSchema, config)).toBe(true)
    }
  })
})

describe('the suite with a field variant', () => {
  const only = 'nondoc-ko-letter'

  async function sentDescriptions(variant: 'default' | 'strict'): Promise<Record<string, string>> {
    const suite = createExtractSuite({ only, kinds: ['text'], fields: variant })
    const requests: LlmRequest[] = []
    const inner = oracleProvider(suite.cases())
    const provider = {
      name: inner.name,
      generate: (request: LlmRequest, options?: { signal?: AbortSignal }) => {
        requests.push(request)
        return inner.generate(request, options)
      },
    }
    await suite.run(suite.cases()[0]!, { provider, signal: new AbortController().signal })
    const properties = requests[0]!.schema.properties as Record<string, { description?: string }>
    return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, schema.description ?? '']))
  }

  it('sends the chosen descriptions to the model', async () => {
    expect(await sentDescriptions('default')).toEqual({ amount: 'total amount paid', date: 'purchase date', vendor: 'merchant name' })
    const strict = await sentDescriptions('strict')
    expect(strict.date).toBe(FIELD_VARIANTS.strict[1].description)
    expect(strict.amount).toContain('null if the document is not a receipt or invoice')
  })

  it('changes the suite version and the recorded versions only for a non-default variant', () => {
    const base = createExtractSuite({ only, kinds: ['text'] })
    const strict = createExtractSuite({ only, kinds: ['text'], fields: 'strict' })
    expect(base.fieldVariant).toBe('default')
    expect(strict.fieldVariant).toBe('strict')
    expect(base.version).not.toContain('-fstrict')
    expect(strict.version).toContain('-fstrict')
    expect(strict.version).not.toBe(base.version)
    expect(extractVersions().field_variant).toBe('default')
    expect(extractVersions('strict').field_variant).toBe('strict')
  })
})

describe('the --fields option', () => {
  it('parses a variant, defaults to default and rejects unknown names', () => {
    expect(parseCli(['extract']).fields).toBe('default')
    expect(parseCli(['extract', '--fields', 'strict']).fields).toBe('strict')
    expect(() => parseCli(['extract', '--fields', 'loose'])).toThrow(/--fields must be one of default, strict/u)
  })

  it('is repeated in the printed command only when it is not the default', () => {
    expect(commandLine(parseCli(['extract']), 1)).not.toContain('--fields')
    expect(commandLine(parseCli(['extract', '--fields', 'strict', '--only', 'nondoc']), 1)).toContain('--fields strict')
  })

  it('is shown in the plan and in the report header', async () => {
    const out: string[] = []
    const io: CliIo = { stdout: (text) => out.push(text), stderr: () => undefined, env: {}, now: () => Date.UTC(2026, 10, 11, 9, 30, 15) }
    expect(await main(['extract', '--fields', 'strict', '--only', 'nondoc-ko-letter', '--kinds', 'text', '--reps', '1', '--models', 'claude-haiku-5-5'], io)).toBe(0)
    const text = out.join('')
    expect(text).toContain('fields: strict (stricter descriptions: null unless the document is a receipt or invoice)')
    expect(text).toContain('--fields strict')
  })
})
