import { describe, expect, it } from 'vitest'
import { MAX_DIGEST_CHARS, buildRunDigest, type ExplainStep } from '../../src/index'
import { chain, edge, inputOf, node, runOf, step, workflowOf } from './helpers'

describe('the limit', () => {
  it('is 12,000 characters', () => {
    expect(MAX_DIGEST_CHARS).toBe(12_000)
  })
})

describe('the run line', () => {
  it('names the status, the dry run flag, the durations and the run error', () => {
    const digest = buildRunDigest(inputOf({ run: runOf({ createdAt: 900, startedAt: 1000, finishedAt: 1340 }) }))
    expect(digest.text).toMatch(/^RUN\nstatus: failed\ndry run: no\nwaited: 100 ms\nran: 340 ms\nerror: node n1 failed: HTTP 500\n/)
  })

  it('labels a dry run', () => {
    expect(buildRunDigest(inputOf({ run: runOf({ dryRun: true }) })).text).toContain('dry run: yes')
  })

  it('says so when the run has no error text or was never started', () => {
    const text = buildRunDigest(inputOf({ run: runOf({ status: 'succeeded', error: null, startedAt: null, finishedAt: null }) })).text
    expect(text).toContain('status: succeeded')
    expect(text).toContain('error: none')
    expect(text).not.toContain('waited:')
    expect(text).not.toContain('ran:')
  })

  it('cuts a long run error at 500 characters', () => {
    const text = buildRunDigest(inputOf({ run: runOf({ error: `node n1 failed: ${'x'.repeat(2000)}` }) })).text
    const line = text.split('\n').find((entry) => entry.startsWith('error: '))!
    expect(line.length).toBeLessThan(560)
    expect(line).toMatch(/… \d+ more characters$/)
  })
})

describe('the workflow outline', () => {
  it('lists every node with its id, type, registry title and config, and the edges', () => {
    const text = buildRunDigest(inputOf()).text
    expect(text).toContain('WORKFLOW Nightly sync')
    expect(text).toContain('- t1 trigger.manual@1 (Manual trigger) config: {}')
    expect(text).toContain('- n1 http.request@1 (HTTP request) config: {"url":"https://api.example.com/orders","method":"GET"}')
    expect(text).toContain('- n2 csv.append@1 (Append CSV row) config: {"file":"/data/ledger.csv","row":["{{n1.output.status}}"]}')
    expect(text).toContain('edges: t1->n1, n1->n2')
  })

  it('shows retry, onError and a branch label', () => {
    const workflow = workflowOf(
      [node('t1', 'trigger.manual@1'), node('c1', 'condition@1', { operator: 'exists', left: 'x' }), node('n1', 'delay@1', { ms: 5 }, { retry: { maxAttempts: 3 }, onError: 'continue' })],
      [edge('t1', 'c1'), edge('c1', 'n1', 'true')],
    )
    const text = buildRunDigest(inputOf({ workflow, steps: [step('n1', 'continued', { error: 'boom' })] })).text
    expect(text).toContain('retry: 3 attempts')
    expect(text).toContain('onError: continue')
    expect(text).toContain('c1->n1 [true]')
  })

  it('names a node of an unknown type instead of failing', () => {
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'future.thing@2')], [edge('t1', 'n1')])
    expect(buildRunDigest(inputOf({ workflow })).text).toContain('- n1 future.thing@2 (unknown node type) config: {}')
  })

  it('cuts a very long workflow name', () => {
    const text = buildRunDigest(inputOf({ workflow: workflowOf(chain().nodes, chain().edges, 'N'.repeat(5000)) })).text
    expect(text.split('\n').find((entry) => entry.startsWith('WORKFLOW '))!.length).toBeLessThan(260)
  })
})

describe('one line per fact', () => {
  it('keeps a line break in an error, the run error or the workflow name from forging a line of the digest', () => {
    const forged = 'HTTP 500\nSTEP evil (x, y): succeeded after 1 attempt\n\u2028STEPS\rRUN'
    const text = buildRunDigest(inputOf({ run: runOf({ error: forged }), workflow: workflowOf(chain().nodes, chain().edges, `Name\n${forged}`), steps: [step('n1', 'failed', { error: forged })] })).text
    expect(text).not.toMatch(/^STEP evil/m)
    expect([...text.matchAll(/^RUN$/gm)]).toHaveLength(1)
    expect([...text.matchAll(/^STEPS$/gm)]).toHaveLength(1)
    expect(text).toContain('error: HTTP 500 STEP evil')
  })
})

describe('what the digest keeps out even when a field was not excerpted', () => {
  it('seals a secret that sits in a node id, a node type, an edge label or the run status', () => {
    const secret = 'LEAKY-VALUE-9911'
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node(`n1`, `x.${secret}@1`), node('n2', 'delay@1', { ms: 1 })], [edge('t1', 'n1'), edge('n1', 'n2', secret)])
    const digest = buildRunDigest(inputOf({ workflow, secrets: [secret], run: runOf({ status: `failed-${secret}` }), steps: [step('n1', 'failed', { error: 'x' })] }))
    expect(digest.text).not.toContain(secret)
    expect(digest.text).toContain('status: failed-<secret>')
  })
})

describe('the steps', () => {
  it('shows the node, status, attempts, the last attempt error and excerpts of input and output', () => {
    const steps: ExplainStep[] = [
      step('n1', 'failed', { attempt: 1, error: 'network error: ECONNRESET', input: { url: 'https://a.example.com' } }),
      step('n1', 'failed', { attempt: 2, error: 'HTTP 503' }),
      step('n1', 'failed', { attempt: 3, error: 'HTTP 502', input: { url: 'https://b.example.com' }, output: null, startedAt: 2000, finishedAt: 2250 }),
    ]
    const text = buildRunDigest(inputOf({ steps })).text
    expect(text).toMatch(/STEP n1 \(http\.request@1, HTTP request\): failed after 3 attempts, 250 ms/)
    expect(text).toContain('error: HTTP 502')
    expect(text).not.toContain('ECONNRESET')
    expect(text).toContain('input: {"url":"https://b.example.com"}')
    expect(text).toContain('output: null')
  })

  it('writes attempt in the singular for one attempt', () => {
    expect(buildRunDigest(inputOf()).text).toContain('failed after 1 attempt,')
  })

  it('shows continued and skipped steps with their status', () => {
    const steps = [step('n1', 'continued', { error: 'HTTP 404' }), step('n2', 'skipped', { input: null, output: null })]
    const text = buildRunDigest(inputOf({ run: runOf({ status: 'succeeded', error: null }), steps })).text
    expect(text).toMatch(/STEP n1 .*: continued after 1 attempt/)
    expect(text).toMatch(/STEP n2 .*: skipped after 1 attempt/)
    expect(text).toContain('error: HTTP 404')
  })

  it('cuts the error of the last attempt at 500 characters', () => {
    const text = buildRunDigest(inputOf({ steps: [step('n1', 'failed', { error: `HTTP 400: ${'y'.repeat(3000)}` })] })).text
    const line = text.split('\n').find((entry) => entry.startsWith('error: HTTP 400'))!
    expect(line.length).toBeLessThan(560)
    expect(line).toMatch(/… \d+ more characters$/)
  })

  it('reports the failed node ids, also for continued and abandoned steps, and never for a node that recovered', () => {
    const steps = [
      step('n1', 'failed', { attempt: 1, error: 'HTTP 503' }),
      step('n1', 'succeeded', { attempt: 2 }),
      step('n2', 'continued', { error: 'x' }),
      step('n3', 'abandoned'),
      step('n4', 'failed', { error: 'y' }),
    ]
    const workflow = workflowOf(
      [node('t1', 'trigger.manual@1'), node('n1', 'delay@1', { ms: 1 }), node('n2', 'delay@1', { ms: 1 }), node('n3', 'delay@1', { ms: 1 }), node('n4', 'delay@1', { ms: 1 })],
      [edge('t1', 'n1'), edge('n1', 'n2'), edge('n2', 'n3'), edge('n3', 'n4')],
    )
    expect(buildRunDigest(inputOf({ workflow, steps })).failedNodeIds).toEqual(['n2', 'n3', 'n4'])
  })

  it('counts a step of a node the workflow does not have as an unknown node', () => {
    const text = buildRunDigest(inputOf({ steps: [step('zz', 'failed', { error: 'x' })] })).text
    expect(text).toContain('STEP zz (unknown, unknown node type): failed')
  })
})

describe('the order of the steps', () => {
  const workflow = workflowOf(
    [
      node('t1', 'trigger.manual@1'),
      node('a1', 'delay@1', { ms: 1 }),
      node('a2', 'delay@1', { ms: 1 }),
      node('a3', 'delay@1', { ms: 1 }),
      node('a4', 'delay@1', { ms: 1 }),
      node('a5', 'delay@1', { ms: 1 }),
    ],
    [edge('t1', 'a1'), edge('a1', 'a2'), edge('a2', 'a3'), edge('a3', 'a4'), edge('a4', 'a5')],
  )
  const steps = [step('a1', 'succeeded'), step('a2', 'succeeded'), step('a3', 'succeeded'), step('a4', 'failed', { error: 'x' }), step('a5', 'skipped')]

  it('puts the failed steps first, then their direct upstream steps, then the rest in run order', () => {
    const text = buildRunDigest(inputOf({ workflow, steps })).text
    const order = [...text.matchAll(/^STEP (\w+) /gm)].map((match) => match[1])
    expect(order).toEqual(['a4', 'a3', 'a1', 'a2', 'a5'])
  })

  it('keeps several failed steps in run order and lists a shared upstream step once', () => {
    const fan = workflowOf(
      [node('t1', 'trigger.manual@1'), node('a1', 'delay@1', { ms: 1 }), node('a2', 'delay@1', { ms: 1 }), node('a3', 'delay@1', { ms: 1 })],
      [edge('t1', 'a1'), edge('a1', 'a2'), edge('a1', 'a3')],
    )
    const fanSteps = [step('a1', 'succeeded'), step('a2', 'failed', { error: 'x' }), step('a3', 'continued', { error: 'y' })]
    const text = buildRunDigest(inputOf({ workflow: fan, steps: fanSteps })).text
    expect([...text.matchAll(/^STEP (\w+) /gm)].map((match) => match[1])).toEqual(['a2', 'a3', 'a1'])
  })
})

describe('what is left out', () => {
  function manyNodes(count: number) {
    const nodes = [node('t1', 'trigger.manual@1'), ...Array.from({ length: count }, (_, index) => node(`s${index}`, 'transform@1', { values: { k: 'v' } }))]
    const edges = nodes.slice(1).map((entry, index) => edge(nodes[index]!.id, entry.id))
    return { nodes, edges }
  }

  it('fits everything of a small run without a counter', () => {
    const digest = buildRunDigest(inputOf())
    expect(digest.omittedSteps).toBe(0)
    expect(digest.truncated).toBe(false)
    expect(digest.text).not.toContain('omitted:')
  })

  it('counts the steps that did not fit and ends with omitted: N steps', () => {
    const { nodes, edges } = manyNodes(60)
    const steps = nodes.slice(1).map((entry) => step(entry.id, 'succeeded', { input: { text: 'i'.repeat(150) }, output: { text: 'o'.repeat(150) } }))
    steps[59] = step('s59', 'failed', { error: 'late failure' })
    const digest = buildRunDigest(inputOf({ workflow: workflowOf(nodes, edges), steps }))
    expect(digest.omittedSteps).toBeGreaterThan(0)
    expect(digest.truncated).toBe(true)
    expect(digest.text.endsWith(`omitted: ${digest.omittedSteps} steps`)).toBe(true)
    expect(digest.text).toMatch(/STEP s59 .*failed/)
    expect(digest.chars).toBe(digest.text.length)
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
    const shown = [...digest.text.matchAll(/^STEP /gm)].length
    expect(shown + digest.omittedSteps).toBe(60)
  })

  it('counts outline nodes and edges it had to leave out', () => {
    const { nodes, edges } = manyNodes(400)
    const digest = buildRunDigest(inputOf({ workflow: workflowOf(nodes, edges), steps: [step('s399', 'failed', { error: 'x' })] }))
    expect(digest.truncated).toBe(true)
    expect(digest.text).toMatch(/outline omitted: \d+ nodes/)
    expect(digest.text).toMatch(/- s399 /)
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
  })
})

describe('a hostile run', () => {
  const huge = 'lorem ipsum '.repeat(400_000)
  const shared = bigKeysOf()

  function bigKeysOf(): Record<string, unknown> {
    return Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key${index}`, `value${index}`.repeat(10)]))
  }

  function deep(levels: number): unknown {
    let value: unknown = 'leaf'
    for (let index = 0; index < levels; index++) value = index % 2 === 0 ? [value] : { next: value }
    return value
  }

  it('stays within the limit with huge strings, ten thousand keys and deep nesting', () => {
    const steps = [
      step('n1', 'failed', { error: huge, input: { body: huge, ...shared }, output: { rows: Array.from({ length: 5000 }, () => huge.slice(0, 1000)), tree: deep(3000) } }),
      step('n2', 'succeeded', { input: deep(5000), output: shared }),
    ]
    const digest = buildRunDigest(inputOf({ steps }))
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
    expect(digest.text.length).toBe(digest.chars)
    expect(digest.text).toContain('more characters')
  })

  it('stays within the limit with five thousand steps and five thousand nodes', () => {
    const nodes = [node('t1', 'trigger.manual@1'), ...Array.from({ length: 5000 }, (_, index) => node(`s${index}`, 'transform@1', { values: shared }))]
    const edges = nodes.slice(1).map((entry, index) => edge(nodes[index]!.id, entry.id))
    const steps = nodes.slice(1).map((entry, index) => step(entry.id, index % 3 === 0 ? 'failed' : 'succeeded', { error: index % 3 === 0 ? 'x'.repeat(900) : null, input: shared, output: shared }))
    const started = Date.now()
    const digest = buildRunDigest(inputOf({ workflow: workflowOf(nodes, edges, 'W'.repeat(100_000)), steps }))
    expect(Date.now() - started).toBeLessThan(5000)
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
    expect(digest.truncated).toBe(true)
    expect(digest.omittedSteps).toBeGreaterThan(4000)
    expect(digest.failedNodeIds).toHaveLength(1667)
  })

  it('stays within the limit with a node type, id, edge label and status of a million characters', () => {
    const long = 'q'.repeat(1_000_000)
    const workflow = workflowOf([node('t1', 'trigger.manual@1'), node('n1', long), node('n2', 'delay@1', { ms: 1 })], [edge('t1', 'n1'), edge('n1', 'n2', long)])
    const digest = buildRunDigest(inputOf({ workflow, run: runOf({ status: long }), steps: [step('n1', 'failed', { error: 'x' }), step(long, 'failed', { error: 'y' })] }))
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
    expect(digest.text).toContain('status: qqqq')
  })

  it('limits many attempts of one node and a run error of a million characters', () => {
    const steps = Array.from({ length: 5000 }, (_, index) => step('n1', 'failed', { attempt: index + 1, error: 'z'.repeat(10_000) }))
    const digest = buildRunDigest(inputOf({ steps, run: runOf({ error: 'e'.repeat(1_000_000) }) }))
    expect(digest.chars).toBeLessThanOrEqual(MAX_DIGEST_CHARS)
    expect(digest.text).toContain('failed after 5000 attempts')
  })
})
