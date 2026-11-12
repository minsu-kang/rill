import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { builtinModules } from 'node:module'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const SAFE = 'The desktop renderer must stay browser-safe.'
const ENGINE_SIDE = ['@rill/engine', '@rill/planner', '@rill/llm', '@rill/recipes', '@rill/eval']

export default defineConfig(
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/storybook-static/**', 'docs/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/desktop/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: { 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}', 'apps/desktop/.storybook/preview.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            ...builtinModules
              .filter((name) => !name.startsWith('node:'))
              .map((name) => ({ name, message: `${SAFE} Node built-ins are not available in the browser.` })),
            ...ENGINE_SIDE.map((name) => ({ name, message: `${SAFE} Use the protocol instead of ${name}.` })),
            { name: '@rill/nodes-core', allowTypeImports: true, message: `${SAFE} Import only types from @rill/nodes-core.` },
          ],
          patterns: [
            { group: ['node:*'], message: `${SAFE} Node built-ins are not available in the browser.` },
            ...ENGINE_SIDE.map((name) => ({ group: [`${name}/*`], message: `${SAFE} Use the protocol instead of ${name}.` })),
            { group: ['@rill/nodes-core/*'], allowTypeImports: true, message: `${SAFE} Import only types from @rill/nodes-core.` },
          ],
        },
      ],
    },
  },
)
