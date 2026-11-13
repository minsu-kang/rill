import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import {
  ASSERTION_NAMES,
  CATALOG_TYPES,
  HOME_DIR,
  evaluateAssertions,
  evaluateExpectation,
  expandHome,
  extractRefs,
  literalPaths,
  matchValue,
  type AssertionResult,
  type CaseContextLike,
  type Produced,
  type Verdict,
} from '../src/suites/planner/assertions'
import { loadPlannerData } from '../src/suites/planner/cases'
import type { Assertion, CaseSpec } from '../src/suites/planner/schema'

const data = loadPlannerData()
const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/planner-parity.json', import.meta.url)), 'utf8')) as {
  matrix: Record<string, Record<string, string>>
  synthetic: Record<string, Record<string, string>>
  mutations: Record<string, Record<string, boolean>>
}

const wf = (nodes: Workflow['nodes'], edges: Workflow['edges'] = []): Workflow => ({ schemaVersion: 1, name: 'w', nodes, edges })
const node = (id: string, type: string, config: Record<string, unknown> = {}, extra: Partial<Workflow['nodes'][number]> = {}) => ({ id, type, config, ...extra })
const ctx = { allowedFolders: ['/Users/demo/Receipts'] }
const run = (assertion: Assertion, workflow: Workflow, context: CaseContextLike = ctx): AssertionResult => {
  const [result] = evaluateAssertions([assertion], workflow, context)
  if (result === undefined) throw new Error('no result')
  return result
}

describe('assertion names', () => {
  it('are the twelve of the vocabulary and every one is documented', () => {
    expect([...ASSERTION_NAMES].sort()).toEqual(
      ['extractsFields', 'hasEdge', 'hasNode', 'hasNodeCount', 'hasRetry', 'hasTrigger', 'noNodeOutsideCatalog', 'noSecretLiteral', 'orderedBefore', 'pathInsideAllowedFolders', 'referencesOutputOf', 'usesConnection'],
    )
    expect(Object.keys(data.vocabulary.assertions).sort()).toEqual([...ASSERTION_NAMES].sort())
    expect(CATALOG_TYPES).toHaveLength(14)
  })
})

describe('matchValue', () => {
  it('compares scalars strictly', () => {
    expect(matchValue(1, 1)).toBe(true)
    expect(matchValue(1, '1')).toBe(false)
    expect(matchValue(null, null)).toBe(true)
    expect(matchValue(null, undefined)).toBe(false)
  })
  it('matches objects as a partial deep subset and rejects missing keys and non-objects', () => {
    expect(matchValue({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true)
    expect(matchValue({ a: 1 }, {})).toBe(false)
    expect(matchValue({ a: 1 }, 'x')).toBe(false)
    expect(matchValue({ a: undefined }, { a: undefined })).toBe(true)
  })
  it('matches arrays as an ordered subsequence with gaps, each actual element used once', () => {
    expect(matchValue([1, 3], [1, 2, 3])).toBe(true)
    expect(matchValue([3, 1], [1, 2, 3])).toBe(false)
    expect(matchValue([1, 1], [1, 2])).toBe(false)
    expect(matchValue([], 'x')).toBe(false)
    expect(matchValue([{ n: 'a' }], [{ n: 'a', t: 1 }])).toBe(true)
  })
  it('supports $contains, $regex and $oneOf, case-insensitively, on strings only', () => {
    expect(matchValue({ $contains: 'LEDGER' }, '~/x/ledger.csv')).toBe(true)
    expect(matchValue({ $contains: 'a' }, 5)).toBe(false)
    expect(matchValue({ $regex: '^0 18 \\* \\* \\*$' }, '0 18 * * *')).toBe(true)
    expect(matchValue({ $regex: '^abc$' }, 'ABC')).toBe(true)
    expect(matchValue({ $regex: '^abc$' }, 'xabc')).toBe(false)
    expect(matchValue({ $oneOf: [1, { $contains: 'z' }] }, 'Zed')).toBe(true)
    expect(matchValue({ $oneOf: [1, 2] }, 3)).toBe(false)
  })
  it('throws on an unknown operator', () => {
    expect(() => matchValue({ $nope: 1 }, 1)).toThrow('unknown config operator: $nope')
  })
})

describe('extractRefs', () => {
  it('finds references anywhere in nested values', () => {
    expect(extractRefs({ a: ['{{n1.output.x.y}} and {{ t1.output }}'], b: 3 })).toEqual([
      { nodeId: 'n1', path: ['x', 'y'] },
      { nodeId: 't1', path: [] },
    ])
  })
})

describe('hasTrigger', () => {
  const a: Assertion = { check: 'hasTrigger', type: 'trigger.cron@1' }
  it('needs exactly one trigger of the type', () => {
    expect(run(a, wf([node('t1', 'trigger.cron@1')])).ok).toBe(true)
    expect(run(a, wf([node('t1', 'trigger.manual@1')])).detail).toBe('trigger is trigger.manual@1')
    expect(run(a, wf([node('t1', 'trigger.cron@1'), node('t2', 'trigger.cron@1')])).ok).toBe(false)
    expect(run(a, wf([node('n1', 'delay@1')])).detail).toBe('trigger is missing')
  })
})

describe('hasNode', () => {
  const workflow = wf([node('t1', 'trigger.manual@1'), node('n1', 'delay@1', { ms: 5 }, { onError: 'continue' })])
  it('matches type, partial config and onError', () => {
    expect(run({ check: 'hasNode', type: 'delay@1' }, workflow).ok).toBe(true)
    expect(run({ check: 'hasNode', type: 'delay@1', config: { ms: 5 } }, workflow).ok).toBe(true)
    expect(run({ check: 'hasNode', type: 'delay@1', config: { ms: 6 } }, workflow).ok).toBe(false)
    expect(run({ check: 'hasNode', type: 'delay@1', onError: 'continue' }, workflow).ok).toBe(true)
    expect(run({ check: 'hasNode', type: 'delay@1', onError: 'fail' }, workflow).ok).toBe(false)
    expect(run({ check: 'hasNode', type: 'transform@1' }, workflow).detail).toBe('no transform@1 node matches')
  })
})

describe('hasNodeCount', () => {
  it('counts inclusively and supports a ban with 0 and 0', () => {
    const workflow = wf([node('t1', 'trigger.manual@1'), node('n1', 'delay@1'), node('n2', 'delay@1')])
    expect(run({ check: 'hasNodeCount', type: 'delay@1', min: 2, max: 2 }, workflow).ok).toBe(true)
    expect(run({ check: 'hasNodeCount', type: 'delay@1', min: 1, max: 1 }, workflow).detail).toBe('2 nodes of delay@1, wanted 1-1')
    expect(run({ check: 'hasNodeCount', type: 'http.request@1', min: 0, max: 0 }, workflow).ok).toBe(true)
    expect(run({ check: 'hasNodeCount', type: 'delay@1', min: 3, max: 4 }, workflow).ok).toBe(false)
  })
})

describe('hasEdge and orderedBefore', () => {
  const workflow = wf(
    [node('t1', 'trigger.manual@1'), node('c1', 'condition@1'), node('n1', 'delay@1'), node('n2', 'notify.slack@1')],
    [{ from: 't1', to: 'c1' }, { from: 'c1', to: 'n1', when: 'true' }, { from: 'n1', to: 'n2' }],
  )
  it('needs a single direct edge, and a label only when asked', () => {
    expect(run({ check: 'hasEdge', fromType: 'condition@1', toType: 'delay@1' }, workflow).ok).toBe(true)
    expect(run({ check: 'hasEdge', fromType: 'condition@1', toType: 'delay@1', when: 'true' }, workflow).ok).toBe(true)
    expect(run({ check: 'hasEdge', fromType: 'condition@1', toType: 'delay@1', when: 'false' }, workflow).detail).toBe('no edge condition@1 -> delay@1 when false')
    expect(run({ check: 'hasEdge', fromType: 'condition@1', toType: 'notify.slack@1' }, workflow).ok).toBe(false)
  })
  it('follows paths of any length and never counts a node as before itself', () => {
    expect(run({ check: 'orderedBefore', typeA: 'condition@1', typeB: 'notify.slack@1' }, workflow).ok).toBe(true)
    expect(run({ check: 'orderedBefore', typeA: 'notify.slack@1', typeB: 'condition@1' }, workflow).ok).toBe(false)
    expect(run({ check: 'orderedBefore', typeA: 'delay@1', typeB: 'delay@1' }, workflow).ok).toBe(false)
  })
  it('does not count a node as before itself even through a loop, only a different node of the type', () => {
    const loop = wf([node('n1', 'delay@1')], [{ from: 'n1', to: 'n1' }])
    expect(run({ check: 'orderedBefore', typeA: 'delay@1', typeB: 'delay@1' }, loop).ok).toBe(false)
    const two = wf([node('n1', 'delay@1'), node('n2', 'delay@1')], [{ from: 'n1', to: 'n2' }])
    expect(run({ check: 'orderedBefore', typeA: 'delay@1', typeB: 'delay@1' }, two).ok).toBe(true)
  })
})

describe('extractsFields', () => {
  const workflow = wf([node('n1', 'llm.extract@1', { fields: [{ name: 'Total' }, { name: 'date' }] })])
  it('needs one node that covers every entry, with alternatives, case-insensitively', () => {
    expect(run({ check: 'extractsFields', names: [['amount', 'total'], 'DATE'] }, workflow).ok).toBe(true)
    expect(run({ check: 'extractsFields', names: [['amount', 'price'], 'date'] }, workflow).ok).toBe(false)
  })
  it('does not combine fields of two different nodes', () => {
    const split = wf([node('n1', 'llm.extract@1', { fields: [{ name: 'a' }] }), node('n2', 'llm.extract@1', { fields: [{ name: 'b' }] })])
    expect(run({ check: 'extractsFields', names: ['a', 'b'] }, split).ok).toBe(false)
  })
})

describe('noNodeOutsideCatalog', () => {
  it('lists the types that are not in the catalog', () => {
    expect(run({ check: 'noNodeOutsideCatalog' }, wf([node('t1', 'trigger.manual@1')])).ok).toBe(true)
    expect(run({ check: 'noNodeOutsideCatalog' }, wf([node('t1', 'trigger.manual@1'), node('n1', 'notion.createPage@1')])).detail).toBe('types outside the catalog: notion.createPage@1')
  })
})

describe('noSecretLiteral', () => {
  const secret = (config: Record<string, unknown>, literals?: string[]) =>
    run({ check: 'noSecretLiteral', ...(literals === undefined ? {} : { literals }) }, wf([node('n1', 'http.request@1', config)]))
  it.each([
    ['a Slack webhook URL', { url: 'https://hooks.slack.com/services/T0/B0/xyz' }],
    ['an xoxb token', { headers: { a: 'xoxb-1234567890-abc' } }],
    ['an sk- key', { body: 'sk-abcdefghijklmnop1234' }],
    ['a Bearer token', { headers: { h: 'Bearer abcdefghijklmnop' } }],
    ['a Basic credential', { headers: { h: 'Basic dXNlcjpwYXNzd29yZA==' } }],
    ['a literal password key', { auth: { password: 'hunter2' } }],
    ['a literal apiKey key, any case', { APIKEY: 'abc' }],
  ])('flags %s', (_name, config) => {
    expect(secret(config).ok).toBe(false)
  })
  it('accepts templates, short values, other keys and empty secrets', () => {
    expect(secret({ headers: { Authorization: 'Bearer {{n0.output.token}}' } }).ok).toBe(true)
    expect(secret({ password: '{{t1.output.pw}}' }).ok).toBe(true)
    expect(secret({ password: '' }).ok).toBe(true)
    expect(secret({ note: 'Bearer short' }).ok).toBe(true)
    expect(secret({ url: 'https://example.com' }).ok).toBe(true)
  })
  it('flags a forbidden literal from the prompt', () => {
    expect(secret({ url: 'https://x.test/abc123' }, ['abc123']).detail).toBe('n1: contains a forbidden literal')
  })
})

describe('pathInsideAllowedFolders', () => {
  const path = (value: string, type = 'csv.append@1', key = 'file') => run({ check: 'pathInsideAllowedFolders' }, wf([node('n1', type, { [key]: value })]))
  it.each([
    ['/Users/demo/Receipts/a.csv', true],
    ['/Users/demo/Receipts', true],
    ['~/Receipts/a.csv', true],
    ['/Users/demo/Receipts2/a.csv', false],
    ['/Users/demo/Receipts/../x.csv', false],
    ['/Users/demo/Receipts/./a.csv', true],
    ['/Users/demo//Receipts/a.csv', true],
    ['/etc/passwd', false],
    ['relative/x.csv', false],
    ['{{t1.output.file}}', true],
    ['{{t1.output.file}}/../x', false],
    ['  /Users/demo/Receipts/a.csv  ', true],
  ])('%s -> %s', (value, ok) => {
    expect(path(value).ok).toBe(ok)
  })
  it('reads the four path keys and ignores others', () => {
    expect(path('/etc/x', 'trigger.folderWatch@1', 'folder').ok).toBe(false)
    expect(path('/etc/x', 'file.read@1', 'path').ok).toBe(false)
    expect(path('/etc/x', 'llm.extract@1', 'file').ok).toBe(false)
    expect(path('/etc/x', 'http.request@1', 'url').ok).toBe(true)
    expect(literalPaths(wf([node('n1', 'csv.append@1', { file: 5 })]))).toEqual([])
  })
  it('passes a workflow without paths and fails every path when no folder is allowed', () => {
    expect(run({ check: 'pathInsideAllowedFolders' }, wf([node('t1', 'trigger.manual@1')])).ok).toBe(true)
    expect(run({ check: 'pathInsideAllowedFolders' }, wf([node('n1', 'csv.append@1', { file: '/Users/demo/a.csv' })]), {}).ok).toBe(false)
  })
  it('expands a leading ~ to the demo home only', () => {
    expect(expandHome('~')).toBe(HOME_DIR)
    expect(expandHome('~/a')).toBe(`${HOME_DIR}/a`)
    expect(expandHome('~a')).toBe('~a')
  })
})

describe('usesConnection', () => {
  it('finds a Slack connection, an http auth connection and a webhook secret', () => {
    const a: Assertion = { check: 'usesConnection', name: 'c1' }
    expect(run(a, wf([node('n1', 'notify.slack@1', { connection: 'c1' })])).ok).toBe(true)
    expect(run(a, wf([node('n1', 'http.request@1', { auth: { connection: 'c1' } })])).ok).toBe(true)
    expect(run(a, wf([node('t1', 'trigger.webhook@1', { secretConnection: 'c1' })])).ok).toBe(true)
    expect(run(a, wf([node('n1', 'delay@1', { connection: 'c1' })])).detail).toBe('connection c1 is not used')
    expect(run(a, wf([node('n1', 'notify.slack@1', { connection: 'c2' })])).ok).toBe(false)
    expect(run(a, wf([node('n1', 'http.request@1', { auth: 'c1' })])).ok).toBe(false)
  })
})

describe('hasRetry', () => {
  it('defaults to 2..10 attempts and honours explicit bounds', () => {
    const workflow = wf([node('n1', 'http.request@1', {}, { retry: { maxAttempts: 3 } }), node('n2', 'delay@1')])
    expect(run({ check: 'hasRetry', nodeType: 'http.request@1' }, workflow).ok).toBe(true)
    expect(run({ check: 'hasRetry', nodeType: 'http.request@1', minAttempts: 4 }, workflow).detail).toBe('no http.request@1 node with retry 4-10')
    expect(run({ check: 'hasRetry', nodeType: 'http.request@1', maxAttempts: 2 }, workflow).ok).toBe(false)
    expect(run({ check: 'hasRetry', nodeType: 'delay@1' }, workflow).ok).toBe(false)
    expect(run({ check: 'hasRetry', nodeType: 'http.request@1' }, wf([node('n1', 'http.request@1', {}, { retry: { maxAttempts: 1 } })])).ok).toBe(false)
  })
})

describe('referencesOutputOf', () => {
  const workflow = wf([
    node('t1', 'trigger.folderWatch@1'),
    node('n1', 'llm.extract@1'),
    node('n2', 'csv.append@1', { row: ['{{n1.output.Amount}}', '{{t1.output.file}}'] }),
  ])
  it('needs a reference from the right node type, optionally to a listed first field', () => {
    expect(run({ check: 'referencesOutputOf', fromType: 'llm.extract@1', toType: 'csv.append@1' }, workflow).ok).toBe(true)
    expect(run({ check: 'referencesOutputOf', fromType: 'llm.extract@1', toType: 'csv.append@1', field: ['total', 'amount'] }, workflow).ok).toBe(true)
    expect(run({ check: 'referencesOutputOf', fromType: 'llm.extract@1', toType: 'csv.append@1', field: 'date' }, workflow).detail).toBe(
      'no csv.append@1 node references the output of llm.extract@1 (date)',
    )
    expect(run({ check: 'referencesOutputOf', fromType: 'trigger.folderWatch@1', toType: 'csv.append@1', field: 'file' }, workflow).ok).toBe(true)
    expect(run({ check: 'referencesOutputOf', fromType: 'delay@1', toType: 'csv.append@1' }, workflow).ok).toBe(false)
  })
  it('requires a first path segment when a field is given', () => {
    const bare = wf([node('n1', 'llm.extract@1'), node('n2', 'csv.append@1', { row: ['{{n1.output}}'] })])
    expect(run({ check: 'referencesOutputOf', fromType: 'llm.extract@1', toType: 'csv.append@1', field: 'x' }, bare).ok).toBe(false)
    expect(run({ check: 'referencesOutputOf', fromType: 'llm.extract@1', toType: 'csv.append@1' }, bare).ok).toBe(true)
  })
})

describe('evaluateExpectation', () => {
  const askCase = data.cases.find((c) => c.id === 'ambig-01-which-folder') as CaseSpec
  const refuseCase = data.cases.find((c) => c.id === 'unsup-01-kakaotalk') as CaseSpec
  const workflowCase = data.cases.find((c) => c.id === 'easy-01-receipt-folder-to-csv') as CaseSpec
  const judge = (c: CaseSpec, produced: Produced): Verdict => evaluateExpectation({ expect: c.expect, context: c.context }, produced)

  it('rejects a produced outcome that no block expects, with one explanatory result', () => {
    const verdict = judge(askCase, { outcome: 'workflow', workflow: wf([node('t1', 'trigger.manual@1')]) })
    expect(verdict).toMatchObject({ ok: false, matchedBlock: -1 })
    expect(verdict.attempts[0]).toEqual([{ assertion: { check: 'outcome' }, ok: false, detail: 'got workflow, wanted questions' }])
  })
  it('counts questions between 1 and maxQuestions and matches topics over the joined text', () => {
    expect(judge(askCase, { outcome: 'questions', questions: ['어느 폴더를 볼까요?'] }).ok).toBe(true)
    expect(judge(askCase, { outcome: 'questions', questions: [] }).ok).toBe(false)
    expect(judge(askCase, { outcome: 'questions', questions: ['폴더?', '2', '3', '4'] }).ok).toBe(false)
    expect(judge(askCase, { outcome: 'questions', questions: ['who?'] }).attempts[0]?.map((r) => r.ok)).toEqual([true, false])
  })
  it('checks that a refusal names the unsupported thing and carries no workflow', () => {
    expect(judge(refuseCase, { outcome: 'unsupported', message: '카카오톡은 지원하지 않습니다' }).ok).toBe(true)
    expect(judge(refuseCase, { outcome: 'unsupported', message: 'nope' }).ok).toBe(false)
    const invented = wf([node('t1', 'trigger.manual@1')])
    const verdict = judge(refuseCase, { outcome: 'unsupported', message: '카카오톡', workflow: invented })
    expect(verdict.ok).toBe(false)
    expect(verdict.attempts[0]?.at(-1)?.detail).toBe('a refusal must not carry a workflow')
  })
  it('reports which alternative block matched', () => {
    const alt = data.cases.find((c) => c.id === 'easy-14-vague-morning') as CaseSpec
    expect(judge(alt, { outcome: 'questions', questions: ['몇 시에 실행할까요?'] })).toMatchObject({ ok: true, matchedBlock: 1 })
    expect(judge(alt, { outcome: 'questions', questions: ['무엇을 보낼까요?'] })).toMatchObject({ ok: false, matchedBlock: -1 })
    expect(judge(alt, { outcome: 'workflow', workflow: data.references[alt.id] as Workflow })).toMatchObject({ ok: true, matchedBlock: 0 })
  })
  it('passes a workflow only when every assertion of the block passes', () => {
    const reference = data.references[workflowCase.id] as Workflow
    expect(judge(workflowCase, { outcome: 'workflow', workflow: reference })).toMatchObject({ ok: true, matchedBlock: 0 })
    const without = { ...reference, nodes: reference.nodes.filter((n) => n.type !== 'csv.append@1') }
    expect(judge(workflowCase, { outcome: 'workflow', workflow: without }).ok).toBe(false)
  })
})

function bitsOf(verdict: Verdict): string {
  return `m${verdict.matchedBlock}:${verdict.attempts.map((attempt) => attempt.map((r) => (r.ok ? 1 : 0)).join('')).join('|')}`
}

const first = (entry: string | readonly string[]): string => (typeof entry === 'string' ? entry : (entry[0] ?? ''))
const degenerate: Workflow = wf([node('t1', 'trigger.manual@1')])

describe('parity with the reference evaluator (plannercases/assertions.mjs)', () => {
  const judge = (c: CaseSpec, produced: Produced): string => bitsOf(evaluateExpectation({ expect: c.expect, context: c.context }, produced))

  it('gives the recorded verdict on every case x reference pair', () => {
    let pairs = 0
    for (const c of data.cases) {
      for (const [key, workflow] of Object.entries(data.references)) {
        expect(judge(c, { outcome: 'workflow', workflow }), `${c.id} x ${key}`).toBe(GOLDEN.matrix[c.id]?.[key])
        pairs += 1
      }
    }
    expect(pairs).toBe(48 * 30)
    expect(Object.values(GOLDEN.matrix).flatMap((row) => Object.values(row)).filter((v) => !v.startsWith('m-1'))).toHaveLength(75)
  })

  it('gives the recorded verdict on synthetic questions and refusals', () => {
    for (const c of data.cases) {
      const blocks = [c.expect, ...(c.expect.alsoAccept ?? [])]
      const out: Record<string, string> = {
        emptyQuestions: judge(c, { outcome: 'questions', questions: [] }),
        shortQuestion: judge(c, { outcome: 'questions', questions: ['x?'] }),
        sixQuestions: judge(c, { outcome: 'questions', questions: ['a?', 'b?', 'c?', 'd?', 'e?', 'f?'] }),
        plainRefusal: judge(c, { outcome: 'unsupported', message: 'x' }),
        degenerate: judge(c, { outcome: 'workflow', workflow: degenerate }),
      }
      const asking = blocks.find((b) => b.outcome === 'questions')
      if (asking?.outcome === 'questions') {
        const good = asking.mustAskAbout.map((entry) => `${first(entry)}?`)
        out['askGood'] = judge(c, { outcome: 'questions', questions: good.slice(0, asking.maxQuestions) })
        out['askUpper'] = judge(c, { outcome: 'questions', questions: [good.join(' ').toUpperCase()] })
        out['askTooMany'] = judge(c, { outcome: 'questions', questions: [...good, ...good, ...good, ...good, ...good, ...good].slice(0, 6) })
      }
      const refusing = blocks.find((b) => b.outcome === 'unsupported')
      if (refusing?.outcome === 'unsupported') {
        const message = refusing.mustMention.map(first).join(' / ')
        const invented = wf([node('t1', refusing.mustNotInvent[0] ?? 'x@1')])
        out['refuseGood'] = judge(c, { outcome: 'unsupported', message })
        out['refuseUpper'] = judge(c, { outcome: 'unsupported', message: message.toUpperCase() })
        out['refuseInvented'] = judge(c, { outcome: 'unsupported', message, workflow: invented })
        out['refuseWithWorkflow'] = judge(c, { outcome: 'unsupported', message, workflow: degenerate })
        out['workflowInvented'] = judge(c, { outcome: 'workflow', workflow: invented })
      }
      expect(out, c.id).toEqual(GOLDEN.synthetic[c.id])
    }
  })

  it('gives the recorded verdict when each node of a reference is removed', () => {
    let checked = 0
    for (const c of data.cases) {
      if (c.expect.outcome !== 'workflow') continue
      const reference = data.references[c.id] as Workflow
      const recorded = GOLDEN.mutations[c.id] ?? {}
      for (const victim of reference.nodes.filter((n) => !n.type.startsWith('trigger.'))) {
        const mutated: Workflow = {
          ...reference,
          nodes: reference.nodes.filter((n) => n.id !== victim.id),
          edges: reference.edges.filter((e) => e.from !== victim.id && e.to !== victim.id),
        }
        const ok = evaluateExpectation({ expect: { ...c.expect, alsoAccept: undefined }, context: c.context }, { outcome: 'workflow', workflow: mutated }).ok
        expect(ok, `${c.id} without ${victim.id}`).toBe(recorded[victim.id])
        checked += 1
      }
    }
    expect(checked).toBe(Object.values(GOLDEN.mutations).reduce((total, row) => total + Object.keys(row).length, 0))
  })
})
