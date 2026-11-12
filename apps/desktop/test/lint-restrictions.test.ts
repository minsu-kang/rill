// @vitest-environment node
import { ESLint } from 'eslint'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const eslint = new ESLint({ cwd: ROOT })

async function problems(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}${file}` })
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'parse-error')
}

describe('eslint import restrictions for the renderer', () => {
  it('reject node modules and the engine side packages in apps/desktop/src', async () => {
    for (const specifier of ['node:fs', 'node:path', 'fs', 'path', '@rill/engine', '@rill/planner', '@rill/llm', '@rill/nodes-core']) {
      const rules = await problems(`import { x } from '${specifier}'\nexport { x }\n`, 'apps/desktop/src/probe.ts')
      expect(rules, specifier).toContain('@typescript-eslint/no-restricted-imports')
    }
  })

  it('reject them in the Storybook preview, which runs in the browser, and leave the node side main file free', async () => {
    for (const specifier of ['node:fs', 'fs', '@rill/engine', '@rill/planner', '@rill/llm', '@rill/nodes-core']) {
      const rules = await problems(`import { x } from '${specifier}'\nexport { x }\n`, 'apps/desktop/.storybook/preview.tsx')
      expect(rules, specifier).toContain('@typescript-eslint/no-restricted-imports')
    }
    const stdin = await problems("export * from '@rill/engine'\n", 'apps/desktop/.storybook/preview.tsx')
    expect(stdin).toContain('@typescript-eslint/no-restricted-imports')
    expect(await problems("import { x } from 'node:fs'\nexport { x }\n", 'apps/desktop/.storybook/main.ts')).toEqual([])
  })

  it('allow type imports of @rill/nodes-core and runtime imports of dsl and protocol', async () => {
    const rules = await problems(
      "import type { NodeDefinition } from '@rill/nodes-core'\nimport { RillError } from '@rill/protocol'\nimport type { Workflow } from '@rill/dsl'\nexport type { NodeDefinition, Workflow }\nexport { RillError }\n",
      'apps/desktop/src/probe.ts',
    )
    expect(rules).toEqual([])
  })

  it('leave the tests and scripts free to use node modules', async () => {
    expect(await problems("import { x } from 'node:fs'\nexport { x }\n", 'apps/desktop/test/probe.ts')).toEqual([])
    expect(await problems("import { x } from '@rill/engine'\nexport { x }\n", 'apps/desktop/scripts/probe.ts')).toEqual([])
  })

  it('check the rules of hooks', async () => {
    const rules = await problems("import { useState } from 'react'\nexport function f(on: boolean) {\n  if (on) useState(0)\n}\n", 'apps/desktop/src/probe.tsx')
    expect(rules).toContain('react-hooks/rules-of-hooks')
  })
})
