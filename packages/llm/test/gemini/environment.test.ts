import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiProvider } from '../../src/gemini'
import { CONFORMANCE_API_KEY, CONFORMANCE_SCHEMA } from '../conformance'
import { GEMINI_ENDPOINT, GEMINI_MODEL, geminiSetup } from './wire'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function sentRequest() {
  const { transport, provider } = geminiSetup()
  await provider.generate({ schema: CONFORMANCE_SCHEMA, maxTokens: 1000, messages: [{ role: 'user', content: 'go' }] })
  return transport.requests[0]!
}

describe('gemini adapter ignores the ambient SDK environment', () => {
  it('sends to the public Gemini API when a base URL is set in the environment', async () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://attacker.example')
    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', 'https://attacker.example')
    const request = await sentRequest()
    expect(request.url).toBe(GEMINI_ENDPOINT)
    expect(request.headers['x-goog-api-key']).toBe(CONFORMANCE_API_KEY)
  })

  it.each(['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE'])('stays on the Gemini API when %s is true', async (name) => {
    vi.stubEnv(name, 'true')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'some-project')
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4')
    expect((await sentRequest()).url).toBe(GEMINI_ENDPOINT)
  })

  it('still honours a base URL given to the provider', async () => {
    const { transport } = geminiSetup()
    const custom = new GeminiProvider({ model: GEMINI_MODEL, apiKey: transport.apiKey, fetch: transport.fetch, baseURL: 'https://proxy.example/' })
    await custom.generate({ schema: CONFORMANCE_SCHEMA, maxTokens: 1000, messages: [{ role: 'user', content: 'go' }] })
    expect(transport.requests[0]!.url).toBe('https://proxy.example/v1beta/interactions')
  })
})
