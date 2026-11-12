// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { METHODS } from '@rill/protocol'
import Value from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { buildCatalog } from '../scripts/build-catalog'

const FIXTURE = join(import.meta.dirname, '../src/fixtures/catalog.json')

describe('catalog fixture', () => {
  const committed: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const real = JSON.parse(JSON.stringify(buildCatalog())) as unknown

  it('is the node catalog of the real registry, exactly as the nodeCatalog method answers it', () => {
    expect(committed).toEqual(real)
  })

  it('has the same node order as the registry', () => {
    const order = (list: unknown) => (list as Array<{ type: string }>).map((n) => n.type)
    expect(order(committed)).toEqual(order(real))
  })

  it('passes the protocol result schema', () => {
    expect(Value.Check(METHODS.nodeCatalog.result, { nodes: committed })).toBe(true)
  })
})
