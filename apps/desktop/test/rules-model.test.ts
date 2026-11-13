// @vitest-environment node
import { normaliseRule, RuleInvalidError } from '@rill/engine'
import type { Workflow } from '@rill/dsl'
import { policyIssues } from '@rill/nodes-core'
import { PLAN_EFFORTS, RULE_MAX_INPUT_CHARS, type Rule, type RuleKind } from '@rill/protocol'
import { describe, expect, it } from 'vitest'
import { catalog } from '../src/fixtures'
import { checkRuleValue, effortCapOf, effortRank, forbiddableNodes, isRuleMessage, splitRules } from '../src/model/rules'

const TYPES = new Set(catalog.map((entry) => entry.type.replace(/@\d+$/, '')))

function engineSays(kind: RuleKind, value: string): { ok: true; value: string } | { ok: false; problem: string } {
  try {
    return { ok: true, value: normaliseRule({ kind, value }, TYPES).value }
  } catch (error) {
    if (error instanceof RuleInvalidError) return { ok: false, problem: error.rule }
    throw error
  }
}

const HOSTS = [
  'api.example.com',
  'API.Example.COM',
  '  api.example.com  ',
  '*.example.com',
  '*.EXAMPLE.com',
  'localhost',
  'a.b.c.d.example.com',
  'xn--mnchen-3ya.de',
  'münchen.de',
  'MÜNCHEN.de',
  '*.münchen.de',
  '日本語.jp',
  'bücher.example',
  '127.0.0.1',
  '*.127.0.0.1',
  '[::1]',
  '::1',
  '[2001:db8::1]',
  '2001:db8::1',
  '*.::1',
  '[::1',
  '[::1]x',
  '[::1]:8080',
  '127.1',
  '0x7f.1',
  '2130706433',
  '1.2.3.999',
  'https://example.com',
  'http://example.com',
  'ftp://example.com',
  'example.com/path',
  'example.com?x=1',
  'example.com#top',
  'example.com\\path',
  'example.com:8080',
  'example.com:',
  'user@example.com',
  'user:pass@example.com',
  'exa mple.com',
  'example.com ',
  'exam\tple.com',
  'example..com',
  '.example.com',
  'example.com.',
  '*',
  '*.',
  '**.example.com',
  'a*.example.com',
  'example.*',
  '*.*.example.com',
  'a_b.example.com',
  '-a.example.com',
  'a-.example.com',
  'a!b.example.com',
  'a<b.example.com',
  'ex%41mple.com',
  `${'a'.repeat(63)}.com`,
  `${'a'.repeat(64)}.com`,
  `${Array.from({ length: 30 }, () => 'abcdefgh').join('.')}.com`,
  'example。com',
  'exam\u200bple.com',
  'exam\u202eple.com',
  'exam\u0001ple.com',
  'exam\u2028ple.com',
  '',
  '   ',
  'x'.repeat(RULE_MAX_INPUT_CHARS + 1),
]

const NODES = ['http.request', 'HTTP.Request', ' http.request ', 'trigger.folderWatch', 'TRIGGER.FOLDERWATCH', 'notify.slack', 'http.request@1', 'nope', 'llm.extract', 'file.read\u202e', '', 'csv.append\n']

const EFFORTS = ['low', 'medium', 'HIGH', ' xhigh ', 'max', 'ultra', '', 'low\u200b', 'x'.repeat(RULE_MAX_INPUT_CHARS + 1)]

describe('the rule check of the renderer and the engine', () => {
  for (const value of HOSTS) {
    it(`say the same for the host ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)}`, () => {
      const here = checkRuleValue('allowHost', value, TYPES)
      const there = engineSays('allowHost', value)
      expect(here).toEqual(there)
    })
  }

  for (const value of NODES) {
    it(`say the same for the node type ${JSON.stringify(value)}`, () => {
      expect(checkRuleValue('forbidNode', value, TYPES)).toEqual(engineSays('forbidNode', value))
    })
  }

  for (const value of EFFORTS) {
    it(`say the same for the effort ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}...` : value)}`, () => {
      expect(checkRuleValue('maxPlanEffort', value, TYPES)).toEqual(engineSays('maxPlanEffort', value))
    })
  }

  it('keeps the catalog spelling of a node type and lower-cases a host', () => {
    expect(checkRuleValue('forbidNode', 'TRIGGER.FOLDERWATCH', TYPES)).toEqual({ ok: true, value: 'trigger.folderWatch' })
    expect(checkRuleValue('allowHost', 'API.Example.COM', TYPES)).toEqual({ ok: true, value: 'api.example.com' })
    expect(checkRuleValue('allowHost', 'münchen.de', TYPES)).toEqual({ ok: true, value: 'xn--mnchen-3ya.de' })
  })

  it('never echoes the value in a problem', () => {
    const result = checkRuleValue('allowHost', 'https://secret.example.com/path', TYPES)
    expect(result).toEqual({ ok: false, problem: 'host_scheme' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('the planning effort order', () => {
  it('ranks the efforts of the protocol from the lowest to the highest', () => {
    expect(PLAN_EFFORTS.map((effort) => effortRank(effort))).toEqual([0, 1, 2, 3, 4])
  })
})

function rule(id: string, kind: RuleKind, value: string, createdAt = 1): Rule {
  return { id, kind, value, createdAt }
}

describe('splitRules', () => {
  it('groups the rules by kind, keeps their order, and finds the cap', () => {
    const all = [rule('a', 'allowHost', 'b.example.com'), rule('b', 'forbidNode', 'http.request'), rule('c', 'maxPlanEffort', 'high'), rule('d', 'allowHost', 'a.example.com'), rule('e', 'forbidNode', 'delay')]
    const groups = splitRules(all)
    expect(groups.hosts.map((item) => item.id)).toEqual(['a', 'd'])
    expect(groups.forbidden.map((item) => item.id)).toEqual(['b', 'e'])
    expect(groups.cap?.id).toBe('c')
  })

  it('has no cap when there is no maxPlanEffort rule', () => {
    expect(splitRules([]).cap).toBeUndefined()
  })
})

describe('effortCapOf', () => {
  it('reads the effort of the maxPlanEffort rule', () => {
    expect(effortCapOf([rule('c', 'maxPlanEffort', 'medium')])).toBe('medium')
  })

  it('is undefined with no rule, and ignores a value it does not know', () => {
    expect(effortCapOf([])).toBeUndefined()
    expect(effortCapOf([rule('c', 'maxPlanEffort', 'ultra')])).toBeUndefined()
    expect(effortCapOf([rule('a', 'allowHost', 'low')])).toBeUndefined()
  })
})

describe('forbiddableNodes', () => {
  it('lists each node type once without its version, with the title of the catalog', () => {
    const list = forbiddableNodes([
      { ...catalog[0]!, type: 'http.request@1', title: 'HTTP request' },
      { ...catalog[0]!, type: 'http.request@2', title: 'HTTP request v2' },
      { ...catalog[1]!, type: 'delay@1', title: 'Delay' },
    ])
    expect(list).toEqual([
      { type: 'http.request', title: 'HTTP request' },
      { type: 'delay', title: 'Delay' },
    ])
  })
})

function workflowOf(...nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>): Workflow {
  return { schemaVersion: 1, name: 'x', nodes, edges: [] } as unknown as Workflow
}

describe('isRuleMessage', () => {
  const policy = { forbiddenNodes: ['delay'], allowedHosts: ['api.example.com'] }
  const messages = (...nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>): string[] => policyIssues(workflowOf(...nodes), policy).map((issue) => issue.message)

  it('knows every message that the validator makes for a rule', () => {
    const made = messages(
      { id: 'n1', type: 'delay@1', config: {} },
      { id: 'n2', type: 'http.request@1', config: { url: 'https://evil.example/path' } },
      { id: 'n3', type: 'http.request@1', config: { url: 'https://{{n1.output.host}}/path' } },
      { id: 'n4', type: 'http.request@1', config: { url: 'not a url' } },
    )
    expect(made).toHaveLength(4)
    for (const message of made) expect(isRuleMessage(message), message).toBe(true)
  })

  it('does not take the message of another check for a rule message', () => {
    for (const message of ['node n1: the field url is required', 'cycle in the graph', 'node n1: the path is outside the allowed folders', 'the host is not in the allowed hosts', '']) {
      expect(isRuleMessage(message), message).toBe(false)
    }
  })

  it('reads a message from the start to the end, so that a longer text is not a rule message', () => {
    expect(isRuleMessage('node n1: the node type delay is forbidden by the rules and more')).toBe(false)
    expect(isRuleMessage('x node n1: the node type delay is forbidden by the rules')).toBe(false)
  })
})
