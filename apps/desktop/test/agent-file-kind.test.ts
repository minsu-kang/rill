import type { AgentFields } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { parseAgentFile, serialiseAgentFile } from '../src/app/agents/agent-file'

const fields: AgentFields = { name: 'Safety reviewer', description: 'Looks for risky settings', persona: 'Strict and calm.', instructions: 'Say what could go wrong.' }

const ASSISTANT_FILE = ['---', 'name: Safety reviewer', 'description: Looks for risky settings', '---', '', '# Persona', '', 'Strict and calm.', '', '# Instructions', '', 'Say what could go wrong.', ''].join('\n')
const REVIEWER_FILE = ASSISTANT_FILE.replace('description: Looks for risky settings\n', 'description: Looks for risky settings\nkind: reviewer\n')

function codes(text: string): string[] {
  return parseAgentFile(text).problems.map((problem) => (problem.kind === 'file' ? problem.code : `${problem.field}.${problem.rule}`))
}

describe('the kind key of the agent file', () => {
  it('is written only for a reviewer, so that the file of an assistant is what it always was', () => {
    expect(serialiseAgentFile(fields)).toEqual({ ok: true, text: ASSISTANT_FILE })
    expect(serialiseAgentFile(fields, 'assistant')).toEqual({ ok: true, text: ASSISTANT_FILE })
    expect(serialiseAgentFile(fields, 'reviewer')).toEqual({ ok: true, text: REVIEWER_FILE })
  })

  it('is read as reviewer or assistant, and is left out of the result when the file has none', () => {
    expect(parseAgentFile(REVIEWER_FILE)).toEqual({ fields, kind: 'reviewer', problems: [] })
    expect(parseAgentFile(ASSISTANT_FILE.replace('---\n\n# Persona', 'kind: assistant\n---\n\n# Persona'))).toEqual({ fields, kind: 'assistant', problems: [] })
    expect(parseAgentFile(ASSISTANT_FILE).kind).toBeUndefined()
  })

  it('round-trips with the text fields', () => {
    const written = serialiseAgentFile(fields, 'reviewer')
    if (!written.ok) throw new Error('expected a file')
    expect(parseAgentFile(written.text)).toEqual({ fields, kind: 'reviewer', problems: [] })
  })

  it('may stand before the description and takes no space or a value with no text', () => {
    expect(parseAgentFile(ASSISTANT_FILE.replace('name: Safety reviewer', 'name: Safety reviewer\nkind: reviewer')).kind).toBe('reviewer')
  })

  it('refuses any other value, in any case, with spaces around it or with no value, by line and never by text', () => {
    for (const value of ['Reviewer', 'REVIEWER', 'admin', 'reviewer ', 'assistant, reviewer', '']) {
      const text = ASSISTANT_FILE.replace('---\n\n# Persona', `kind: ${value}\n---\n\n# Persona`)
      const parsed = parseAgentFile(text)
      expect(parsed.problems, JSON.stringify(value)).toEqual([{ kind: 'file', code: 'invalid_kind', line: 4 }])
      expect(JSON.stringify(parsed.problems)).not.toContain('admin')
    }
    expect(codes(ASSISTANT_FILE.replace('---\n\n# Persona', 'kind:\n---\n\n# Persona'))).toEqual(['invalid_kind'])
  })

  it('refuses a repeated kind, and keeps every other key unknown', () => {
    expect(codes(REVIEWER_FILE.replace('kind: reviewer', 'kind: reviewer\nkind: assistant'))).toEqual(['duplicate_key'])
    expect(codes(REVIEWER_FILE.replace('kind: reviewer', 'kind: reviewer\nskills: a, b'))).toEqual(['unknown_key'])
    expect(codes(REVIEWER_FILE.replace('kind: reviewer', 'Kind: reviewer'))).toEqual(['unknown_key'])
  })
})
