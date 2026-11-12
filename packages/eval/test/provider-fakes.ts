import { createHash } from 'node:crypto'
import { replyOf as openaiReply } from '../../llm/test/openai-wire'
import { okReply as grokReply } from '../../llm/test/grok/wire'
import { streamReply as geminiReply } from '../../llm/test/gemini/wire'
import { chatReply as metaReply } from '../../llm/test/meta-wire'
import { createFakeTransport, jsonReply, type FakeReply } from '../../llm/test/fake-transport'
import type { FetchFn } from '../src/record'

export interface VendorFake {
  id: 'anthropic' | 'openai' | 'gemini' | 'grok' | 'meta'
  spec: string
  keyEnv: string
  reply(text: string): FakeReply
  shape?(answer: unknown, body: Record<string, unknown>): unknown
}

type Json = Record<string, unknown>

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function fillNulls(value: unknown, schema: unknown): unknown {
  if (!isJson(schema)) return value
  if (Array.isArray(schema['anyOf'])) {
    const branch = schema['anyOf'].find((entry) => !(isJson(entry) && entry['type'] === 'null'))
    return value === null ? null : fillNulls(value, branch)
  }
  if (Array.isArray(value)) return value.map((entry) => fillNulls(entry, schema['items']))
  if (isJson(value) && isJson(schema['properties'])) {
    return Object.fromEntries(Object.entries(schema['properties']).map(([name, child]) => [name, name in value ? fillNulls(value[name], child) : null]))
  }
  return value
}

export const VENDORS: readonly VendorFake[] = [
  {
    id: 'anthropic',
    spec: 'claude-sonnet-5-5',
    keyEnv: 'ANTHROPIC_API_KEY',
    reply: (text) =>
      jsonReply({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
  },
  {
    id: 'openai',
    spec: 'openai:gpt-6.1-sol',
    keyEnv: 'OPENAI_API_KEY',
    reply: (text) => openaiReply(false, 'completed', text),
    shape: (answer, body) => fillNulls(answer, ((body['text'] as Json | undefined)?.['format'] as Json | undefined)?.['schema']),
  },
  { id: 'gemini', spec: 'gemini:gemini-3.8-flash', keyEnv: 'GEMINI_API_KEY', reply: (text) => geminiReply(text) },
  { id: 'grok', spec: 'grok:grok-4.7', keyEnv: 'XAI_API_KEY', reply: (text) => grokReply({ text }) },
  { id: 'meta', spec: 'meta:muse-spark-1.3', keyEnv: 'META_API_KEY', reply: (text) => metaReply(text) },
]

export function stringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringLeaves(entry, into)
  else if (isJson(value)) for (const entry of Object.values(value)) stringLeaves(entry, into)
  return into
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const TAGGED_TEXT = /^<(document-[0-9a-f]+)>\n([\s\S]*)\n<\/\1>$/u
const DATA_URL = /^data:[^;,]*;base64,([\s\S]*)$/u
const BASE64 = /^[A-Za-z0-9+/=\s]+$/u

export function documentKeys(body: unknown): string[] {
  const keys: string[] = []
  for (const leaf of stringLeaves(body)) {
    const tagged = TAGGED_TEXT.exec(leaf)
    if (tagged?.[2] !== undefined) {
      keys.push(sha256(Buffer.from(tagged[2], 'utf8')))
      continue
    }
    const url = DATA_URL.exec(leaf)
    if (url?.[1] !== undefined) keys.push(sha256(Buffer.from(url[1], 'base64')))
    else if (leaf.length >= 40 && BASE64.test(leaf)) keys.push(sha256(Buffer.from(leaf, 'base64')))
  }
  return keys
}

export interface OracleFetch {
  fetch: FetchFn
  bodies: Json[]
}

export function vendorFetch(vendor: VendorFake, answerOf: (body: Json, text: string) => unknown): OracleFetch {
  const bodies: Json[] = []
  const fetch: FetchFn = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Json
    bodies.push(body)
    const answer = answerOf(body, stringLeaves(body).join('\n'))
    const shaped = vendor.shape === undefined ? answer : vendor.shape(answer, body)
    const transport = createFakeTransport()
    transport.script(vendor.reply(JSON.stringify(shaped)))
    return transport.fetch(input, init)
  }
  return { fetch, bodies }
}
