import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCoreRegistry } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS } from '../../protocol/src/index'
import { PACKAGE_ROOT } from '../src/results'
import { CASES_PATH, PAIRS_PATH, REFERENCES_PATH, VOCABULARY_PATH } from '../src/suites/planner/cases'
import { LONG_WHY, MEMORY_NOTES_MAX, MEMORY_NOTE_CHARS, OPEN_TRIGGER, PENDING_REAPPROVAL, checkConsistency, type ConsistencyInput } from '../src/suites/planner/consistency'

type Json = Record<string, unknown>

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const manifest = read(join(PACKAGE_ROOT, 'fixtures/extract/manifest.json')) as { files: ConsistencyInput['manifest'] }

function shipped(): ConsistencyInput {
  return {
    cases: read(CASES_PATH),
    references: read(REFERENCES_PATH),
    pairs: read(PAIRS_PATH),
    vocabulary: read(VOCABULARY_PATH),
    registry: createCoreRegistry(),
    seeds: read(join(PACKAGE_ROOT, 'src/suites/extract/data/seeds.json')) as { id: string }[],
    manifest: manifest.files,
    fixtureExists: (path) => existsSync(join(PACKAGE_ROOT, 'fixtures/extract', path)),
  }
}

interface Mutable {
  input: ConsistencyInput
  cases: Json[]
  refs: Json
  pairs: Json[]
  notes(id: string): string[]
  c(id: string): Json
  expectOf(id: string): Json
  assertions(id: string): Json[]
  context(id: string): Json
}

function mutable(): Mutable {
  const input = shipped()
  const cases = input.cases as Json[]
  const refs = input.references as Json
  const byId = (id: string): Json => {
    const found = cases.find((entry) => entry['id'] === id)
    if (found === undefined) throw new Error(`no case ${id}`)
    return found
  }
  return {
    input,
    cases,
    refs,
    pairs: input.pairs as Json[],
    notes: (id) => (byId(id)['context'] as Json)['memory'] as string[],
    c: byId,
    expectOf: (id) => byId(id)['expect'] as Json,
    assertions: (id) => (byId(id)['expect'] as Json)['assertions'] as Json[],
    context: (id) => byId(id)['context'] as Json,
  }
}

const EASY = 'easy-01-receipt-folder-to-csv'
const EASY_CSV = 'easy-06-english-receipt-csv'
const ASK = 'ambig-01-which-folder'
const UNSUP = 'unsup-01-kakaotalk'
const PATCH = 'patch-01-change-schedule'
const ATTACH = 'attach-01-sample-pdf-extract-to-csv'
const SLACK = 'easy-03-webhook-to-slack'
const BRANCH = 'easy-04-large-receipt-branch'
const MEM = 'mem-01-folder-from-note'
const CONTROL = 'mem-02-same-request-without-memory'
const FULL_LIST = 'mem-07-one-of-twenty-notes'
const OPEN = 'easy-25-google-sheet-one-connection'
const LONG = 'easy-22-slack-no-channel-named'

const withAssertion = (d: Mutable, id: string, assertion: Json): void => {
  d.assertions(id).push(assertion)
}

const MOST_KOREAN = 'most prompts should be Korean'

const withKoreanCount = (d: Mutable, count: number): void => {
  let korean = d.cases.filter((entry) => entry['language'] === 'ko')
  for (const entry of korean.slice(count)) entry['language'] = 'en'
  korean = d.cases.filter((entry) => entry['language'] === 'ko')
  expect(korean).toHaveLength(count)
}

const MUTATIONS: [string, string, (d: Mutable) => void][] = [
  ['a case with an unknown key', 'cases.json: ', (d) => void (d.c(EASY)['extra'] = 1)],
  ['a case without why', 'cases.json: ', (d) => void delete d.expectOf(EASY)['why']],
  ['a duplicate id', 'duplicate id', (d) => void (d.c(EASY_CSV)['id'] = EASY)],
  ['an id that is not easy-01-slug', 'id must look like', (d) => void (d.c(EASY)['id'] = 'easy-1-Bad')],
  ['an id prefix of another category', 'id prefix does not match category', (d) => void (d.c(EASY)['id'] = 'patch-99-receipt')],
  ['an unknown tag', 'tags must be a subset', (d) => void (d.c(EASY)['tags'] = ['nope'])],
  ['a prompt over 600 characters', 'up to 600 characters', (d) => void (d.c(EASY)['prompt'] = '영수증 '.repeat(200))],
  ['language en with Hangul', 'language en but the prompt is not English', (d) => void (d.c(EASY)['language'] = 'en')],
  ['language ko without Hangul', 'language ko but the prompt has no Hangul', (d) => void (d.c(EASY_CSV)['language'] = 'ko')],
  ['language mixed without mixing', 'language mixed but the prompt does not mix', (d) => void Object.assign(d.c(EASY), { language: 'mixed', prompt: '영수증 정리' })],
  ['duplicate connections', 'connections must be unique strings', (d) => void (d.context(SLACK)['connections'] = ['slack-ops', 'slack-ops'])],
  ['a folder with a trailing slash', 'allowedFolders must be absolute', (d) => void (d.context(EASY)['allowedFolders'] = ['/Users/demo/Receipts/'])],
  ['a folder outside the demo home', 'allowedFolders must be absolute', (d) => void (d.context(EASY)['allowedFolders'] = ['/tmp/Receipts'])],
  ['a patch case without a selected node', 'patch cases need existingWorkflow and selectedNodeId', (d) => void delete d.context(PATCH)['selectedNodeId']],
  ['a selected node that does not exist', 'is not a node of existingWorkflow', (d) => void (d.context(PATCH)['selectedNodeId'] = 'zz')],
  [
    'an existing workflow with an unknown connection',
    'unknown_connection',
    (d) => void (((d.context(PATCH)['existingWorkflow'] as Json)['nodes'] as Json[])[2]!['config'] = { connection: 'nope', text: 'x' }),
  ],
  ['an easy case with an existing workflow', 'existingWorkflow/selectedNodeId only belong to patch cases', (d) => void (d.context(EASY)['selectedNodeId'] = 't1')],
  ['an attachment that is no seed', 'is not a seed id in seeds.json', (d) => void (((d.context(ATTACH)['attachments'] as Json[])[0] as Json)['fixture'] = 'no-such-seed')],
  ['an attachment with an empty note', 'note must be a non-empty string', (d) => void (((d.context(ATTACH)['attachments'] as Json[])[0] as Json)['note'] = '')],
  ['an attachment case without attachments', 'attachment cases need attachments', (d) => void (d.context(ATTACH)['attachments'] = [])],
  ['attachments on an easy case', 'attachments only belong to attachment cases', (d) => void (d.context(EASY)['attachments'] = [{ kind: 'pdf', fixture: 'x', note: 'x' }])],
  [
    'an easy case that expects questions',
    'category easy expects outcome workflow',
    (d) => void (d.c(EASY)['expect'] = { ...d.expectOf(ASK), why: 'Ask first.' }),
  ],
  ['a why over 420 characters', 'why is longer than 420 characters', (d) => void (d.expectOf(EASY)['why'] = `${'x'.repeat(430)}.`)],
  ['a why of two sentences', 'why must be one sentence', (d) => void (d.expectOf(EASY)['why'] = 'First one. Second one.')],
  ['a why without a period', 'why must end with a period', (d) => void (d.expectOf(EASY)['why'] = 'No period')],
  ['a workflow block with four assertions', 'needs at least 5 assertions', (d) => void d.assertions(EASY).splice(4)],
  [
    'a workflow block without noNodeOutsideCatalog',
    'must include noNodeOutsideCatalog',
    (d) => void (d.expectOf(EASY)['assertions'] = d.assertions(EASY).filter((a) => a['check'] !== 'noNodeOutsideCatalog')),
  ],
  [
    'a workflow block that does not pin the trigger',
    'must pin the trigger',
    (d) => void (d.expectOf(EASY)['assertions'] = d.assertions(EASY).filter((a) => a['check'] !== 'hasTrigger' && !(a['check'] === 'hasNode' && String(a['type']).startsWith('trigger.')))),
  ],
  ['a duplicated assertion', 'duplicate assertion', (d) => withAssertion(d, EASY, structuredClone(d.assertions(EASY)[0]!))],
  ['an assertion on an unknown node type', 'node type not in the real catalog', (d) => withAssertion(d, EASY, { check: 'hasNodeCount', type: 'nope.x@1', min: 0, max: 0 })],
  ['an assertion on a malformed node type', 'bad node type', (d) => withAssertion(d, EASY, { check: 'hasNodeCount', type: 'Nope', min: 0, max: 0 })],
  ['hasTrigger on an action', 'is not a trigger', (d) => withAssertion(d, EASY, { check: 'hasTrigger', type: 'delay@1' })],
  ['hasNode with an empty config', 'config must be a non-empty object', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: {} })],
  ['hasNode with an unknown config property', 'is not a config property', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: { nope: 1 } })],
  ['hasNode with a value the schema rejects', 'is not valid for the config schema', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'delay@1', config: { ms: 'soon' } })],
  ['hasNode with a bad regex', 'invalid regular expression', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: { file: { $regex: '(' } } })],
  ['hasNode with an unknown operator', 'unknown operator', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: { file: { $nope: 'x' } } })],
  ['hasNode with a one-candidate $oneOf', 'needs at least two candidates', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: { file: { $oneOf: ['a'] } } })],
  ['hasNode with an empty $contains', '$contains needs a non-empty string', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: { file: { $contains: '' } } })],
  ['hasNode with an array where the schema has none', 'expected an array in the schema', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'csv.append@1', config: { file: ['a'] } })],
  ['onError on a trigger', 'onError does not apply to a trigger', (d) => withAssertion(d, EASY, { check: 'hasNode', type: 'trigger.folderWatch@1', onError: 'fail' })],
  ['hasNodeCount with min above max', 'min/max must be integers', (d) => withAssertion(d, EASY, { check: 'hasNodeCount', type: 'delay@1', min: 2, max: 1 })],
  ['hasEdge with when from a node that never branches', 'never produces a branch', (d) => withAssertion(d, EASY, { check: 'hasEdge', fromType: 'csv.append@1', toType: 'delay@1', when: 'true' })],
  ['hasEdge with a label the node never produces', 'is not one of', (d) => withAssertion(d, BRANCH, { check: 'hasEdge', fromType: 'condition@1', toType: 'notify.slack@1', when: 'maybe' })],
  ['orderedBefore towards a trigger', 'must not be a trigger here', (d) => withAssertion(d, EASY, { check: 'orderedBefore', typeA: 'csv.append@1', typeB: 'trigger.folderWatch@1' })],
  ['extractsFields with a bad field name', 'does not match the llm.extract name pattern', (d) => withAssertion(d, EASY, { check: 'extractsFields', names: ['Bad Name'] })],
  ['extractsFields with empty alternatives', 'must be a non-empty string or array', (d) => withAssertion(d, EASY, { check: 'extractsFields', names: [[]] })],
  ['extractsFields with a repeated alternative', 'has duplicate alternatives', (d) => withAssertion(d, EASY, { check: 'extractsFields', names: [['a', 'A']] })],
  ['pathInsideAllowedFolders without a folder', 'needs at least one allowed folder', (d) => void (d.context(EASY)['allowedFolders'] = [])],
  ['usesConnection with an unknown name', 'is not in context.connections', (d) => withAssertion(d, SLACK, { check: 'usesConnection', name: 'nope' })],
  ['hasRetry with attempts out of range', 'must be an integer 1-10', (d) => withAssertion(d, EASY, { check: 'hasRetry', nodeType: 'llm.extract@1', maxAttempts: 11 })],
  ['hasRetry with min above max', 'minAttempts > maxAttempts', (d) => withAssertion(d, EASY, { check: 'hasRetry', nodeType: 'llm.extract@1', minAttempts: 5, maxAttempts: 3 })],
  ['hasRetry on a trigger', 'must not be a trigger here', (d) => withAssertion(d, EASY, { check: 'hasRetry', nodeType: 'trigger.folderWatch@1' })],
  ['referencesOutputOf with a field the node never outputs', 'has no output field', (d) => withAssertion(d, EASY, { check: 'referencesOutputOf', fromType: 'trigger.folderWatch@1', toType: 'llm.extract@1', field: 'nope' })],
  ['a questions block with maxQuestions 0', 'maxQuestions must be an integer 1-5', (d) => void (d.expectOf(ASK)['maxQuestions'] = 0)],
  ['a questions block with maxQuestions 6', 'maxQuestions must be an integer 1-5', (d) => void (d.expectOf(ASK)['maxQuestions'] = 6)],
  ['a questions block without topics', 'mustAskAbout must be a non-empty array', (d) => void (d.expectOf(ASK)['mustAskAbout'] = [])],
  ['an unsupported block with one invented type', 'needs at least two invented node types', (d) => void (d.expectOf(UNSUP)['mustNotInvent'] = ['kakao.send@1'])],
  ['an unsupported block inventing a real type', 'is a real catalog type', (d) => void (d.expectOf(UNSUP)['mustNotInvent'] = ['kakao.send@1', 'delay@1'])],
  ['an unsupported block with a malformed invented type', 'is not a well-formed node type', (d) => void (d.expectOf(UNSUP)['mustNotInvent'] = ['kakao.send@1', 'Kakao'])],
  ['an empty alsoAccept', 'alsoAccept must be a non-empty array', (d) => void (d.expectOf(UNSUP)['alsoAccept'] = [])],
  ['a missing case', 'expected exactly 61 cases', (d) => void d.cases.pop()],
  ['an extra case', 'expected exactly 61 cases, found 62', (d) => void d.cases.push({ ...structuredClone(d.c(EASY)), id: 'easy-98-extra' })],
  ['a changed category count', 'counts: ', (d) => void (d.c(EASY)['category'] = 'patch')],
  ['too few hard prompts', 'need at least 6 hard prompts', (d) => d.cases.forEach((entry) => void delete entry['tags'])],
  ['too few Korean prompts', MOST_KOREAN, (d) => withKoreanCount(d, Math.floor(d.cases.length / 2))],
  ['an effort that is rarely used', 'effort low is used only', (d) => d.cases.forEach((entry) => void (entry['effort'] = 'medium'))],
  ['too few easy over-ask cases', 'need at least 3 easy over-ask cases', (d) => d.cases.forEach((entry) => void (entry['tags'] = ((entry['tags'] as string[] | undefined) ?? []).filter((tag) => tag !== 'over-ask')))],
  ['an assertion missing from the vocabulary', 'missing hasRetry', (d) => void delete ((d.input.vocabulary as Json)['assertions'] as Json)['hasRetry']],
  ['an undocumented assertion in the vocabulary', 'documents unknown assertion', (d) => void (((d.input.vocabulary as Json)['assertions'] as Json)['extra'] = {})],
  [
    'a reference that no expectation asks for',
    'reference without a workflow expectation',
    (d) => void (d.refs['easy-99-orphan'] = d.refs[EASY]),
  ],
  ['a missing reference', 'no reference solution in references.json', (d) => void delete d.refs[EASY]],
  [
    'a reference that fails an assertion',
    'fails on the reference',
    (d) => void (d.refs[EASY] = { ...(d.refs[EASY] as Json), nodes: ((d.refs[EASY] as Json)['nodes'] as Json[]).filter((n) => n['type'] !== 'csv.append@1'), edges: [] }),
  ],
  [
    'a reference that uses an unknown connection',
    'unknown_connection',
    (d) => void ((((d.refs[SLACK] as Json)['nodes'] as Json[]).find((n) => n['type'] === 'notify.slack@1') as Json)['config'] = { connection: 'nope', text: 'x' }),
  ],
  [
    'a reference with an invalid config',
    'config_',
    (d) => void ((((d.refs[EASY] as Json)['nodes'] as Json[]).find((n) => n['type'] === 'csv.append@1') as Json)['config'] = { file: 5, row: [] }),
  ],
  [
    'a reference with a path outside the allowed folders',
    'path_outside_roots',
    (d) => void ((((d.refs[EASY] as Json)['nodes'] as Json[]).find((n) => n['type'] === 'csv.append@1') as Json)['config'] = { file: '/etc/ledger.csv', row: ['x'] }),
  ],
  [
    'a reference with a retry on a trigger',
    'retry/onError on a trigger',
    (d) => void (((d.refs[EASY] as Json)['nodes'] as Json[])[0]!['retry'] = { maxAttempts: 2 }),
  ],
  ['a patch reference equal to the existing workflow', 'the patch reference equals the existing workflow', (d) => void (d.refs[PATCH] = d.context(PATCH)['existingWorkflow'])],
  [
    'a reference with a reference to an unknown field',
    'unknown_output_field',
    (d) => void ((((d.refs[EASY] as Json)['nodes'] as Json[]).find((n) => n['type'] === 'csv.append@1') as Json)['config'] = { file: '/Users/demo/Receipts/ledger.csv', row: ['{{t1.output.nope}}'] }),
  ],
  [
    'an expectation a bare workflow satisfies',
    'a bare manual-trigger workflow passes the expectation',
    (d) =>
      void (d.expectOf(EASY)['assertions'] = [
        { check: 'hasNodeCount', type: 'delay@1', min: 0, max: 0 },
        { check: 'hasNodeCount', type: 'http.request@1', min: 0, max: 0 },
        { check: 'hasNodeCount', type: 'notify.slack@1', min: 0, max: 0 },
        { check: 'hasNodeCount', type: 'condition@1', min: 0, max: 0 },
        { check: 'noNodeOutsideCatalog' },
        { check: 'hasNode', type: 'trigger.manual@1' },
      ]),
  ],
  [
    'an expectation with fewer than three failing assertions on a bare workflow',
    'assertions fail on a bare workflow',
    (d) =>
      void (d.expectOf(EASY)['assertions'] = [
        { check: 'hasTrigger', type: 'trigger.folderWatch@1' },
        { check: 'hasNodeCount', type: 'delay@1', min: 0, max: 0 },
        { check: 'hasNodeCount', type: 'http.request@1', min: 0, max: 0 },
        { check: 'hasNodeCount', type: 'notify.slack@1', min: 0, max: 0 },
        { check: 'noNodeOutsideCatalog' },
        { check: 'noSecretLiteral' },
      ]),
  ],
  [
    'an assertion that survives removing the node it names',
    'still passes',
    (d) => {
      const ref = d.refs[EASY] as Json
      const nodes = ref['nodes'] as Json[]
      nodes.push({ id: 'n9', type: 'csv.append@1', config: { file: '/Users/demo/Receipts/ledger.csv', row: ['{{n1.output.amount}}'] } })
      ;(ref['edges'] as Json[]).push({ from: 'n1', to: 'n9' })
    },
  ],
  ['a memory case with the id prefix of another category', 'id prefix does not match category', (d) => void (d.c(MEM)['id'] = 'easy-99-folder-from-note')],
  ['a note with a line break', 'is not one line', (d) => void (d.notes(MEM)[0] = 'one\ntwo')],
  ['a note with a control character', 'is not one line', (d) => void (d.notes(MEM)[0] = 'one\ttwo')],
  ['a note with a bidi character', 'is not one line', (d) => void (d.notes(MEM)[0] = `one${String.fromCharCode(0x202e)}two`)],
  ['a note with a double space', 'is not normalised', (d) => void (d.notes(MEM)[0] = 'one  two')],
  ['a note with a space at the end', 'is not normalised', (d) => void (d.notes(MEM)[0] = 'one two ')],
  ['an empty note', 'is empty', (d) => void (d.notes(MEM)[0] = '')],
  ['a note over the character limit', 'is longer than', (d) => void (d.notes(MEM)[0] = 'x'.repeat(MEMORY_NOTE_CHARS + 1))],
  ['more notes than the limit', 'at most 20 notes', (d) => void d.notes(FULL_LIST).push('one more note')],
  ['a note that repeats another note in other case', 'duplicate note', (d) => void (d.notes(FULL_LIST)[1] = d.notes(FULL_LIST)[0]!.toUpperCase())],
  ['an empty notes list', 'notes must not be an empty list', (d) => void (d.context(MEM)['memory'] = [])],
  ['notes on the control case', 'the control case must have no notes', (d) => void (d.context(CONTROL)['memory'] = ['a note'])],
  ['no notes on a memory case that is not a control', 'must be the control of a pair', (d) => void delete d.context(MEM)['memory']],
  ['a control that differs from the case it reuses', 'the control differs from the case', (d) => void (d.c(CONTROL)['prompt'] = '영수증 정리해서 이메일로 알려줘.')],
  ['a pair that names an unknown case', 'names an unknown case', (d) => void (d.pairs[0]!['with'] = 'mem-99-nothing')],
  ['a pair whose control expects a workflow', 'the control must expect questions', (d) => void (d.pairs[0]!['without'] = MEM)],
  ['a pair whose case with notes expects questions', 'the case with notes must expect a workflow', (d) => void (d.pairs[0]!['with'] = CONTROL)],
  ['a pair that reuses a case that is not ambiguous', 'which is not an ambiguous case', (d) => void (d.pairs[0]!['reuses'] = EASY)],
  ['a pair of two cases that differ by more than the notes', 'differ by more than the notes', (d) => void (d.c(MEM)['prompt'] = '영수증 정리해줘.')],
  ['a pair with a case outside the memory category', 'a pair is made of two memory cases', (d) => void (d.pairs[0]!['without'] = ASK)],
  ['a reference of a memory case outside the allowed folders', 'path_outside_roots', (d) => void ((((d.refs[MEM] as Json)['nodes'] as Json[])[0] as Json)['config'] = { folder: '/etc/receipts' })],
  ['a memory case that expects a workflow without a reference', 'no reference solution in references.json', (d) => void delete d.refs[MEM]],
]

describe('shipped planner data', () => {
  it('is consistent: no problems, the documented shape and every catalog node but transform used', () => {
    const result = checkConsistency(shipped())
    expect(result.problems).toEqual([])
    expect(result.summary).toMatchObject({
      cases: 61,
      category: { easy: 25, ambiguous: 10, unsupported: 7, attachment: 8, patch: 4, memory: 7 },
      language: { ko: 48, en: 8, mixed: 5 },
      effort: { low: 22, medium: 24, high: 15 },
      outcome: { workflow: 43, questions: 11, unsupported: 7 },
      hard: 11,
      references: 43,
      unusedTypes: ['transform@1'],
    })
    expect(result.summary?.coveredTypes).toHaveLength(13)
  })

  it.each(MUTATIONS)('detects %s', (_name, expected, mutate) => {
    const d = mutable()
    mutate(d)
    const { problems } = checkConsistency(d.input)
    expect(problems.some((problem) => problem.includes(expected)), problems.join('\n')).toBe(true)
  })

  it('asks for a Korean majority of the cases: half of them fails, one more passes', () => {
    const half = mutable()
    withKoreanCount(half, Math.floor(half.cases.length / 2))
    expect(checkConsistency(half.input).problems.join('\n')).toContain(`${MOST_KOREAN} (found 30 of 61)`)
    const majority = mutable()
    withKoreanCount(majority, Math.floor(majority.cases.length / 2) + 1)
    expect(checkConsistency(majority.input).problems.join('\n')).not.toContain(MOST_KOREAN)
  })

  it('detects a fixture that is missing in the manifest or on disk', () => {
    const missing = shipped()
    missing.manifest = missing.manifest.filter((entry) => !(entry.seedId === 'easy-ko-cafe-yeonnam' && entry.kind === 'pdf'))
    expect(checkConsistency(missing).problems.join('\n')).toContain('no pdf fixture for easy-ko-cafe-yeonnam in manifest.json')
    const gone = shipped()
    gone.fixtureExists = () => false
    expect(checkConsistency(gone).problems.join('\n')).toContain('fixture file missing on disk: pdf/easy-ko-cafe-yeonnam.pdf')
  })

  it('has no refusal that waits for a decision, because the Google Sheets refusal became a workflow case', () => {
    expect(PENDING_REAPPROVAL).toEqual({})
    const ids = (shipped().cases as Json[]).map((entry) => entry['id'])
    expect(ids).not.toContain('unsup-02-google-sheets')
    expect(ids).toContain(OPEN)
  })

  it('accepts the field name orderDate in every case whose prompt asks for the order date', () => {
    const asking = (shipped().cases as Json[]).filter((entry) => String(entry['prompt']).includes('주문 날짜'))
    expect(asking.map((entry) => entry['id'])).toEqual([
      'attach-04-text-injection-outside-path',
      'attach-07-slack-channel-in-attachment',
      'attach-08-spreadsheet-id-in-attachment',
      'mem-06-note-url-beats-attachment-url',
    ])
    for (const entry of asking) expect(JSON.stringify(entry['expect']), String(entry['id'])).toContain('"orderDate"')
  })

  it('accepts a refusal that a node now covers when it is listed as a pending decision', () => {
    const d = mutable()
    d.expectOf(UNSUP)['mustMention'] = [['slack message', 'slack']]
    d.input.pending = { [UNSUP]: 'notify.slack@1 now covers it' }
    expect(checkConsistency(d.input).problems).toEqual([])
  })

  it('reports an unsupported case that a node of the catalog now covers', () => {
    const d = mutable()
    d.expectOf(UNSUP)['mustMention'] = [['slack message', 'slack']]
    expect(checkConsistency(d.input).problems.join('\n')).toContain(`${UNSUP}: expects a refusal, but notify.slack@1 ("Slack message") now covers it`)
    const alias = mutable()
    alias.expectOf(UNSUP)['alsoAccept'] = [{ outcome: 'unsupported', mustMention: [['EXCEL']], mustNotInvent: ['xl.append@1', 'xl.write@1'] }]
    expect(checkConsistency(alias.input).problems.join('\n')).toContain(`${UNSUP}: expects a refusal, but microsoft.excel.append@1 ("Append row to Excel") now covers it`)
  })

  it('reports a pending decision that the catalog no longer needs', () => {
    const d = mutable()
    d.input.pending = { [UNSUP]: 'a node used to cover it' }
    expect(checkConsistency(d.input).problems.join('\n')).toContain(`${UNSUP}: waits for a decision that the catalog no longer needs`)
  })

  it('reports a pending decision that names no case', () => {
    const d = mutable()
    d.input.pending = { 'unsup-99-nothing': 'a node covers it' }
    expect(checkConsistency(d.input).problems.join('\n')).toContain('unsup-99-nothing: waits for a decision but is not a case')
  })

  it('lets only the Google Sheets case leave the trigger open, because the request names none', () => {
    expect(Object.keys(OPEN_TRIGGER)).toEqual([OPEN])
    const d = mutable()
    expect(d.assertions(OPEN).some((assertion) => assertion['check'] === 'hasTrigger' || String(assertion['type']).startsWith('trigger.'))).toBe(false)
    expect(checkConsistency(d.input).problems).toEqual([])
    const unlisted = mutable()
    unlisted.input.openTrigger = {}
    expect(checkConsistency(unlisted.input).problems.join('\n')).toContain(`${OPEN}.expect: workflow expectations must pin the trigger`)
  })

  it('reports a case that is listed as leaving the trigger open but pins one, or is not a case', () => {
    const pinned = mutable()
    pinned.assertions(OPEN).push({ check: 'hasTrigger', type: 'trigger.folderWatch@1' })
    expect(checkConsistency(pinned.input).problems.join('\n')).toContain(`${OPEN}: is listed as leaving the trigger open but pins one`)
    const listed = mutable()
    listed.input.openTrigger = { [EASY]: 'a reason', 'easy-99-nothing': 'a reason' }
    const problems = checkConsistency(listed.input).problems.join('\n')
    expect(problems).toContain(`${EASY}: is listed as leaving the trigger open but pins one`)
    expect(problems).toContain('easy-99-nothing: is listed as leaving the trigger open but is not a case')
  })

  it('lets only four approved cases keep a why of two sentences', () => {
    expect(Object.keys(LONG_WHY).sort()).toEqual(
      ['attach-07-slack-channel-in-attachment', 'attach-08-spreadsheet-id-in-attachment', 'easy-22-slack-no-channel-named', 'easy-23-google-sheet-row'].sort(),
    )
    for (const id of Object.keys(LONG_WHY)) expect(/[.!?]\s+[A-Z]/.test((mutable().expectOf(id)['why'] as string)), id).toBe(true)
    const unlisted = mutable()
    unlisted.input.longWhy = {}
    const problems = checkConsistency(unlisted.input).problems
    expect(problems.filter((problem) => problem.includes('why must be one sentence'))).toHaveLength(4)
  })

  it('reports a case that is listed as keeping a long why but has one sentence, or is not a case', () => {
    const d = mutable()
    d.expectOf(LONG)['why'] = 'The user names no channel, so the default channel of the connection is used.'
    d.input.longWhy = { [LONG]: 'a reason', 'easy-99-nothing': 'a reason' }
    const problems = checkConsistency(d.input).problems.join('\n')
    expect(problems).toContain(`${LONG}: is listed as having a long why but its why is one sentence`)
    expect(problems).toContain('easy-99-nothing: is listed as having a long why but is not a case')
  })

  it('keeps the other new cases to one sentence of at most 420 characters', () => {
    const d = mutable()
    for (const id of [OPEN, 'easy-21-slack-channel-named', 'easy-24-excel-file-and-table']) {
      const why = d.expectOf(id)['why'] as string
      expect(why.length, id).toBeLessThanOrEqual(420)
      expect(/[.!?]\s+[A-Z]/.test(why), id).toBe(false)
    }
  })

  it('stops at the schema when the pairs are not a list of pairs', () => {
    const input = shipped()
    input.pairs = { nope: true }
    const result = checkConsistency(input)
    expect(result.summary).toBeUndefined()
    expect(result.problems[0]).toMatch(/^pairs\.json: /)
    input.pairs = [{ with: MEM, without: CONTROL }]
    expect(checkConsistency(input).problems[0]).toMatch(/^pairs\.json: /)
  })

  it('checks the notes against the limits of the engine', () => {
    expect(MEMORY_NOTES_MAX).toBe(MEMORY_MAX_ITEMS)
    expect(MEMORY_NOTE_CHARS).toBe(MEMORY_MAX_CHARS)
  })

  it('refuses notes on a case that is not a memory case, and counts a memory case that was moved away', () => {
    const notes = mutable()
    notes.context(EASY)['memory'] = ['a note']
    expect(checkConsistency(notes.input).problems.some((problem) => problem.includes('memory notes only belong to memory cases'))).toBe(true)
    const moved = mutable()
    moved.c(EASY)['category'] = 'memory'
    expect(checkConsistency(moved.input).problems.some((problem) => problem.includes('memory: expected 7, found 8'))).toBe(true)
  })

  it('detects a catalog that differs from the evaluator', () => {
    const input = shipped()
    const registry = createCoreRegistry()
    const list = registry.list()
    input.registry = Object.assign(Object.create(registry) as typeof registry, { list: () => list.slice(1) })
    expect(checkConsistency(input).problems.join('\n')).toContain('CATALOG_TYPES differs from the real registry')
  })

  it('stops at the schema when the cases are not an array of cases', () => {
    const input = shipped()
    input.cases = { nope: true }
    const result = checkConsistency(input)
    expect(result.summary).toBeUndefined()
    expect(result.problems[0]).toMatch(/^cases\.json: /)
    input.cases = []
    input.references = 5
    expect(checkConsistency(input).problems).toEqual(['references.json: must be an object'])
  })

  it('reports a reference whose shape is invalid', () => {
    const d = mutable()
    d.refs[EASY] = { schemaVersion: 2, nodes: 'x' }
    const { problems } = checkConsistency(d.input)
    expect(problems.some((problem) => problem.startsWith(`${EASY}.reference: shape`))).toBe(true)
  })
})
