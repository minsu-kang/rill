import { expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../src/index'

it('exposes the DSL schema version', () => {
  expect(SCHEMA_VERSION).toBe(1)
})
