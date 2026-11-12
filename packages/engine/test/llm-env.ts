import { afterEach, beforeEach } from 'vitest'

export const KEY_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'META_API_KEY'] as const

export const MARKER_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-MARKER-a1f3c9d2e8b74',
  OPENAI_API_KEY: 'sk-oai-MARKER-b2e4d0a3f9c85',
  GEMINI_API_KEY: 'gem-MARKER-c3f5e1b4a0d96',
  XAI_API_KEY: 'xai-MARKER-d4a6f2c5b1e07',
  META_API_KEY: 'meta-MARKER-e5b7a3d6c2f18',
} as const

export const MARKER_VALUES: string[] = Object.values(MARKER_KEYS)

export function isolateKeyEnvironment(): void {
  let saved: Array<[string, string | undefined]> = []
  beforeEach(() => {
    saved = KEY_VARIABLES.map((name) => [name, process.env[name]])
    for (const name of KEY_VARIABLES) delete process.env[name]
  })
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

export function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of KEY_VARIABLES) delete env[name]
  delete env.ANTHROPIC_BASE_URL
  return { ...env, ...extra }
}

export function mentionsAny(text: string, values: readonly string[]): string | undefined {
  return values.find((value) => text.includes(value))
}
