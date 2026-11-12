import { describe, expect, it } from 'vitest'
import { FAILURE_SIGNALS, failureSignals, type FailureSignal } from '../../src/index'
import { edge, node, registry, step, workflowOf } from './helpers'

const workflow = workflowOf(
  [
    node('t1', 'trigger.manual@1'),
    node('h1', 'http.request@1', { url: 'https://api.example.com' }),
    node('f1', 'file.read@1', { path: '/data/in.txt' }),
    node('l1', 'llm.extract@1', { file: '/data/in.pdf', fields: [{ name: 'a', type: 'string' }] }),
    node('s1', 'notify.slack@1', { connection: 'team', text: 'x' }),
    node('c1', 'csv.append@1', { file: '/data/out.csv', row: ['a'] }),
    node('k1', 'condition@1', { operator: 'gt', left: 'a', right: 1 }),
    node('d1', 'delay@1', { ms: 1 }),
  ],
  [edge('t1', 'h1')],
)

const CASES: Array<[string, string, FailureSignal]> = [
  ['h1', 'unknown connection: api', 'unknown_connection'],
  ['s1', 'unknown connection: team', 'unknown_connection'],
  ['f1', 'path is outside the allowed folders: /etc/passwd', 'path_not_allowed'],
  ['c1', 'path must be absolute or start with ~/: out.csv', 'path_not_allowed'],
  ['f1', "path must not contain '..': /data/../etc", 'path_not_allowed'],
  ['f1', 'path is a dangling symlink: /data/link', 'path_not_allowed'],
  ['h1', "invalid config: /url: Expected string to match '^https?://'", 'invalid_config'],
  ['h1', 'invalid request: the URL or a header is malformed', 'invalid_config'],
  ['h1', 'unsupported protocol: ftp:', 'invalid_config'],
  ['h1', 'GET requests cannot have a body', 'invalid_config'],
  ['d1', 'unresolved reference: h1.output.missing', 'unresolved_reference'],
  ['h1', 'HTTP 401: {"error":"bad token"}', 'http_status_401_403'],
  ['h1', 'HTTP 403: forbidden', 'http_status_401_403'],
  ['h1', 'HTTP 404: not found', 'http_status_404'],
  ['h1', 'HTTP 429', 'http_status_429'],
  ['h1', 'HTTP 500', 'http_status_5xx'],
  ['h1', 'HTTP 503', 'http_status_5xx'],
  ['h1', 'HTTP 418: teapot', 'http_status_4xx'],
  ['h1', 'HTTP 400: bad request', 'http_status_4xx'],
  ['h1', 'HTTP 302: redirects are not followed', 'unknown'],
  ['h1', 'response is larger than 5242880 bytes', 'unknown'],
  ['h1', 'network error: ECONNREFUSED', 'network_error'],
  ['h1', 'network error: ENOTFOUND', 'network_error'],
  ['h1', 'network error: TimeoutError', 'timeout'],
  ['h1', 'network error: ETIMEDOUT', 'timeout'],
  ['h1', 'network error: UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['h1', 'network error: UND_ERR_HEADERS_TIMEOUT', 'timeout'],
  ['s1', 'network error: ECONNREFUSED', 'network_error'],
  ['s1', 'HTTP 404: no_service', 'slack_error'],
  ['s1', 'HTTP 403: invalid_token', 'slack_error'],
  ['s1', 'HTTP 429', 'http_status_429'],
  ['s1', 'HTTP 503', 'http_status_5xx'],
  ['f1', "ENOENT: no such file or directory, stat '/data/in.txt'", 'file_missing'],
  ['f1', "EACCES: permission denied, open '/data/in.txt'", 'file_unreadable'],
  ['f1', 'not a file: /data', 'file_unreadable'],
  ['f1', 'file is larger than maxBytes (20 > 10): /data/in.txt', 'file_unreadable'],
  ['f1', 'something else entirely', 'unknown'],
  ['l1', "ENOENT: no such file or directory, open '/data/in.pdf'", 'file_missing'],
  ['l1', 'file is empty: /data/in.pdf', 'file_unreadable'],
  ['l1', 'file is not valid UTF-8 text: /data/in.txt', 'file_unreadable'],
  ['l1', 'file content does not look like application/pdf: /data/in.pdf', 'file_unreadable'],
  ['l1', 'unsupported file type for llm.extract: .xyz', 'file_unreadable'],
  ['l1', 'file is larger than the limit (30 > 20): /data/in.pdf', 'file_unreadable'],
  ['l1', 'llm.extract needs an LLM provider; start the engine with --llm-provider and its key variable', 'llm_unavailable'],
  ['l1', 'the model provider rejected the credentials (401)', 'llm_unavailable'],
  ['l1', 'no Anthropic credentials found; set ANTHROPIC_API_KEY', 'llm_unavailable'],
  ['l1', 'the model returned an unexpected shape for the declared fields', 'llm_extract_failed'],
  ['l1', 'llm.extract cannot read a PDF with the grok provider: /data/in.pdf', 'llm_extract_failed'],
  ['l1', 'overloaded', 'llm_extract_failed'],
  ['c1', "EISDIR: illegal operation on a directory, open '/data/out.csv'", 'csv_error'],
  ['c1', "ENOSPC: no space left on device, write", 'csv_error'],
  ['k1', 'comparison needs two numbers or two strings', 'condition_error'],
  ['k1', 'operator gt needs a right value', 'condition_error'],
  ['k1', 'contains needs a string or an array on the left', 'condition_error'],
  ['d1', 'permanent', 'unknown'],
]

describe('failureSignals', () => {
  it.each(CASES)('classifies %s: %s as %s', (nodeId, error, expected) => {
    expect(failureSignals([step(nodeId, 'failed', { error })], registry, workflow)).toEqual([{ nodeId, signal: expected }])
  })

  it('covers every signal of the list in the table', () => {
    const covered = new Set(CASES.map(([, , signal]) => signal))
    for (const signal of FAILURE_SIGNALS) expect(covered.has(signal), signal).toBe(true)
  })

  it('looks at the last attempt of a node only', () => {
    const steps = [step('h1', 'failed', { attempt: 1, error: 'HTTP 503' }), step('h1', 'failed', { attempt: 2, error: 'HTTP 401: x' })]
    expect(failureSignals(steps, registry, workflow)).toEqual([{ nodeId: 'h1', signal: 'http_status_401_403' }])
  })

  it('gives nothing for a node that recovered, succeeded, was skipped or is still running', () => {
    const steps = [
      step('h1', 'failed', { attempt: 1, error: 'HTTP 503' }),
      step('h1', 'succeeded', { attempt: 2 }),
      step('f1', 'succeeded'),
      step('l1', 'skipped'),
      step('s1', 'running'),
      step('c1', 'abandoned'),
    ]
    expect(failureSignals(steps, registry, workflow)).toEqual([])
  })

  it('includes a continued step', () => {
    expect(failureSignals([step('h1', 'continued', { error: 'HTTP 404: x' })], registry, workflow)).toEqual([{ nodeId: 'h1', signal: 'http_status_404' }])
  })

  it('answers unknown for a failed step without an error text', () => {
    expect(failureSignals([step('h1', 'failed', { error: null })], registry, workflow)).toEqual([{ nodeId: 'h1', signal: 'unknown' }])
  })

  it('lists the nodes in run order, one entry each', () => {
    const steps = [step('f1', 'failed', { error: 'not a file: /x' }), step('h1', 'failed', { error: 'HTTP 500' }), step('f1', 'failed', { attempt: 2, error: 'not a file: /x' })]
    expect(failureSignals(steps, registry, workflow).map((entry) => entry.nodeId)).toEqual(['f1', 'h1'])
  })

  it('leaves out a step of a node the workflow does not have', () => {
    expect(failureSignals([step('zz', 'failed', { error: 'unknown connection: x' })], registry, workflow)).toEqual([])
  })

  it('applies only the general patterns to a node of a type the registry does not have', () => {
    const odd = workflowOf([node('t1', 'trigger.manual@1'), node('x1', 'future.thing@1')], [edge('t1', 'x1')])
    expect(failureSignals([step('x1', 'failed', { error: 'HTTP 404: x' })], registry, odd)).toEqual([{ nodeId: 'x1', signal: 'http_status_404' }])
    expect(failureSignals([step('x1', 'failed', { error: 'unknown connection: x' })], registry, odd)).toEqual([{ nodeId: 'x1', signal: 'unknown_connection' }])
    expect(failureSignals([step('x1', 'failed', { error: 'comparison needs two numbers or two strings' })], registry, odd)).toEqual([{ nodeId: 'x1', signal: 'unknown' }])
    expect(failureSignals([step('x1', 'failed', { error: "EISDIR: illegal operation on a directory, open '/x'" })], registry, odd)).toEqual([{ nodeId: 'x1', signal: 'unknown' }])
  })

  it('carries a signal id and a node id only, never text of the run', () => {
    const [entry] = failureSignals([step('h1', 'failed', { error: 'HTTP 401: SECRET-IN-BODY' })], registry, workflow)
    expect(Object.keys(entry!).sort()).toEqual(['nodeId', 'signal'])
    expect(JSON.stringify(entry)).not.toContain('SECRET-IN-BODY')
  })
})
