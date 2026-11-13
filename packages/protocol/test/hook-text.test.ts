import { describe, expect, it } from 'vitest'
import {
  HOOK_CHANNEL_MAX_CHARS,
  HOOK_CONNECTION_MAX_CHARS,
  HOOK_FIELDS,
  HOOK_RULES,
  HOOK_WORKFLOW_LABEL_MAX_CHARS,
  hookMessage,
  hookProblemLine,
  hookWorkflowLabel,
  normaliseHookText,
  parseHookProblemLine,
  type HookProblem,
} from '../src/index'

describe('normaliseHookText for a connection name', () => {
  const check = (raw: string) => normaliseHookText('connection', raw)

  it('keeps a plain name exactly, because the engine looks it up by its exact spelling', () => {
    expect(check('team-slack')).toEqual({ ok: true, value: 'team-slack' })
    expect(check('Team Slack 2')).toEqual({ ok: true, value: 'Team Slack 2' })
    expect(check('e\u0301cole')).toEqual({ ok: true, value: 'e\u0301cole' })
    expect(check('  spaced  ')).toEqual({ ok: true, value: '  spaced  ' })
  })

  it('refuses an empty name and a name of spaces', () => {
    expect(check('')).toEqual({ ok: false, rule: 'empty' })
    expect(check('   ')).toEqual({ ok: false, rule: 'empty' })
  })

  it('refuses control, separator, bidirectional and invisible format characters', () => {
    expect(check('a\nb')).toEqual({ ok: false, rule: 'control_character' })
    expect(check('a\u0000b')).toEqual({ ok: false, rule: 'control_character' })
    expect(check('a\u007fb')).toEqual({ ok: false, rule: 'control_character' })
    expect(check('a\u2028b')).toEqual({ ok: false, rule: 'line_separator' })
    expect(check('a\u2029b')).toEqual({ ok: false, rule: 'line_separator' })
    for (const char of ['\u202e', '\u202a', '\u2066', '\u2069', '\u200e', '\u200f', '\u061c']) expect(check(`a${char}b`), char).toEqual({ ok: false, rule: 'bidi_format' })
    for (const char of ['\u200b', '\u2060', '\ufeff', '\u00ad', '\u{e0041}', '\u{e0100}']) expect(check(`a${char}b`), char).toEqual({ ok: false, rule: 'format_character' })
    expect(check('a\ud800b')).toEqual({ ok: false, rule: 'format_character' })
  })

  it('allows the joiners that some scripts need, like the other user text', () => {
    expect(check('a\u200cb')).toEqual({ ok: true, value: 'a\u200cb' })
    expect(check('a\u200db')).toEqual({ ok: true, value: 'a\u200db' })
  })

  it('refuses a name over the limit and counts characters, not code units', () => {
    expect(check('c'.repeat(HOOK_CONNECTION_MAX_CHARS)).ok).toBe(true)
    expect(check('c'.repeat(HOOK_CONNECTION_MAX_CHARS + 1))).toEqual({ ok: false, rule: 'too_long' })
    expect(check('\u{1f600}'.repeat(HOOK_CONNECTION_MAX_CHARS)).ok).toBe(true)
    expect(check('\u{1f600}'.repeat(HOOK_CONNECTION_MAX_CHARS + 1))).toEqual({ ok: false, rule: 'too_long' })
  })
})

describe('normaliseHookText for a channel', () => {
  const check = (raw: string) => normaliseHookText('channel', raw)

  it('composes to NFC, trims, and turns an empty channel into no channel', () => {
    expect(check('#alerts')).toEqual({ ok: true, value: '#alerts' })
    expect(check('  #alerts \n')).toEqual({ ok: true, value: '#alerts' })
    expect(check('C0123ABCDEF')).toEqual({ ok: true, value: 'C0123ABCDEF' })
    expect(check('#e\u0301quipe')).toEqual({ ok: true, value: '#\u00e9quipe' })
    expect(check('')).toEqual({ ok: true, value: '' })
    expect(check('   ')).toEqual({ ok: true, value: '' })
  })

  it('refuses a space inside the channel, as notify.slack does', () => {
    expect(check('#my alerts')).toEqual({ ok: false, rule: 'whitespace' })
    expect(check('#my\u00a0alerts')).toEqual({ ok: false, rule: 'whitespace' })
    expect(check('#my\u3000alerts')).toEqual({ ok: false, rule: 'whitespace' })
  })

  it('refuses control, separator, bidirectional and invisible format characters', () => {
    expect(check('#a\tb')).toEqual({ ok: false, rule: 'control_character' })
    expect(check('#a\u2028b')).toEqual({ ok: false, rule: 'line_separator' })
    expect(check('#a\u202eb')).toEqual({ ok: false, rule: 'bidi_format' })
    expect(check('#a\u200bb')).toEqual({ ok: false, rule: 'format_character' })
  })

  it('refuses a channel over 80 code units, the limit of notify.slack', () => {
    expect(check('c'.repeat(HOOK_CHANNEL_MAX_CHARS)).ok).toBe(true)
    expect(check('c'.repeat(HOOK_CHANNEL_MAX_CHARS + 1))).toEqual({ ok: false, rule: 'too_long' })
    expect(check('\u{1f600}'.repeat(HOOK_CHANNEL_MAX_CHARS / 2)).ok).toBe(true)
    expect(check('\u{1f600}'.repeat(HOOK_CHANNEL_MAX_CHARS / 2 + 1))).toEqual({ ok: false, rule: 'too_long' })
  })
})

describe('the problem lines', () => {
  it('are field.rule followed by a fixed sentence for every field and rule that can occur', () => {
    const seen = new Set<string>()
    for (const field of HOOK_FIELDS) {
      for (const rule of HOOK_RULES) {
        const line = hookProblemLine({ field, rule })
        expect(line.startsWith(`${field}.${rule}: `), line).toBe(true)
        expect(line.length).toBeGreaterThan(`${field}.${rule}: `.length + 5)
        expect(parseHookProblemLine(line)).toEqual({ field, rule })
        seen.add(line)
      }
    }
    expect(seen.size).toBe(HOOK_FIELDS.length * HOOK_RULES.length)
  })

  it('parse back, and refuse what is not a line of this kind', () => {
    const problem: HookProblem = { field: 'action', rule: 'forbidden_by_rule' }
    expect(parseHookProblemLine(hookProblemLine(problem))).toEqual(problem)
    expect(parseHookProblemLine('nonsense')).toBeUndefined()
    expect(parseHookProblemLine('action.unknown_rule: text')).toBeUndefined()
    expect(parseHookProblemLine('colour.empty: text')).toBeUndefined()
    expect(parseHookProblemLine('action.empty:')).toBeUndefined()
  })

  it('name the rule of a hook that is refused by a rule, as the plan does', () => {
    expect([...HOOK_RULES]).toEqual(expect.arrayContaining(['forbidden_by_rule', 'duplicate', 'unknown_workflow', 'unknown_connection', 'not_slack_connection', 'out_of_range', 'only_for_run_failed']))
  })
})

describe('hookWorkflowLabel', () => {
  it('keeps an ordinary name', () => {
    expect(hookWorkflowLabel('Receipts to CSV')).toBe('Receipts to CSV')
    expect(hookWorkflowLabel('영수증 정리')).toBe('영수증 정리')
  })

  it('escapes the Slack control characters so that a name cannot make a mention or a link', () => {
    expect(hookWorkflowLabel('<!channel>')).toBe('&lt;!channel&gt;')
    expect(hookWorkflowLabel('<@U123>')).toBe('&lt;@U123&gt;')
    expect(hookWorkflowLabel('<https://evil.example|click>')).toBe('&lt;https://evil.example|click&gt;')
    expect(hookWorkflowLabel('a & b')).toBe('a &amp; b')
    expect(hookWorkflowLabel('&lt;already&gt;')).toBe('&amp;lt;already&amp;gt;')
    expect(hookWorkflowLabel('<>&')).not.toMatch(/[<>]/)
  })

  it('removes control, line separator, bidirectional and invisible format characters', () => {
    expect(hookWorkflowLabel('a\nb\tc\u0000d')).toBe('abcd')
    expect(hookWorkflowLabel('a\u2028b\u2029c')).toBe('abc')
    expect(hookWorkflowLabel('a\u202eb\u202ac\u2066d\u200fe')).toBe('abcde')
    expect(hookWorkflowLabel('a\u200bb\u200cc\u200dd\u2060e\ufeff\u00adf')).toBe('abcdef')
    expect(hookWorkflowLabel('a\u{e0041}\u{e0100}b')).toBe('ab')
    expect(hookWorkflowLabel('a\u3164b\u2800c')).toBe('abc')
    expect(hookWorkflowLabel('a\ud800b')).toBe('ab')
  })

  it('turns runs of spaces into one space and trims the ends', () => {
    expect(hookWorkflowLabel('  a   b \u00a0 c  ')).toBe('a b c')
  })

  it('cuts to 60 characters, by code point, and cuts before it escapes', () => {
    expect(HOOK_WORKFLOW_LABEL_MAX_CHARS).toBe(60)
    expect(hookWorkflowLabel('x'.repeat(100))).toBe('x'.repeat(60))
    expect([...hookWorkflowLabel('\u{1f600}'.repeat(100))]).toHaveLength(60)
    expect(hookWorkflowLabel('&'.repeat(100))).toBe('&amp;'.repeat(60))
    expect(hookWorkflowLabel(`${'a'.repeat(59)}<tail>`)).toBe(`${'a'.repeat(59)}&lt;`)
    expect(hookWorkflowLabel(`${'a'.repeat(59)} tail`)).toBe('a'.repeat(59))
  })

  it('counts only the characters it keeps toward the 60', () => {
    expect(hookWorkflowLabel(`${'\u200b'.repeat(500)}${'x'.repeat(70)}`)).toBe('x'.repeat(60))
  })

  it('stays fast and bounded for a huge name', () => {
    const started = Date.now()
    expect(hookWorkflowLabel('\u200b'.repeat(2_000_000))).toBe('unnamed')
    expect(hookWorkflowLabel('a'.repeat(2_000_000))).toBe('a'.repeat(60))
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('falls back to a fixed word when nothing visible is left', () => {
    for (const name of ['', '   ', '\u200b\u200b', '\n\t', '\u202e']) expect(hookWorkflowLabel(name), JSON.stringify(name)).toBe('unnamed')
  })
})

describe('hookMessage', () => {
  it('is a fixed English sentence per event with the workflow name in quotes', () => {
    expect(hookMessage('run.failed', 'Receipts')).toBe('Workflow "Receipts" failed.')
    expect(hookMessage('run.succeeded', 'Receipts')).toBe('Workflow "Receipts" finished.')
    expect(hookMessage('plan.deployed', 'Receipts')).toBe('Workflow "Receipts" was deployed.')
  })

  it('uses the safe form of the name', () => {
    expect(hookMessage('run.failed', '<!channel>\u202e & more')).toBe('Workflow "&lt;!channel&gt; &amp; more" failed.')
    expect(hookMessage('run.failed', '\u200b')).toBe('Workflow "unnamed" failed.')
  })

  it('has no other free text, so that its length is bounded', () => {
    expect(hookMessage('plan.deployed', '&'.repeat(5000)).length).toBeLessThan(60 * 5 + 40)
  })
})
