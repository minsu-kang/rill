import { describe, expect, it } from 'vitest'
import { createFakeWorld } from '../src/app/fake-world'
import { ids } from '../src/fixtures'
import { node, workflowOf } from '../src/fixtures/workflows'

function world() {
  return createFakeWorld({ hostOptions: { restartDelayMs: 0 }, control: { stepIntervalMs: 0 } })
}

describe('the fake world and checkRules', () => {
  it('lists no workflow while there is no rule', async () => {
    expect((await world().client.request('checkRules', {})).violations).toEqual([])
  })

  it('lists the workflows that call a host the allowed hosts do not cover, with the message of the engine', async () => {
    const env = world()
    await env.client.request('saveRule', { kind: 'allowHost', value: 'other.example.org' })
    const { violations } = await env.client.request('checkRules', {})
    const branching = violations.find((entry) => entry.workflowId === ids.workflows.branching)
    expect(branching?.issues).toEqual([
      { stage: 3, pointer: '/nodes/1/config/url', code: 'rule_violation', message: 'node check: the host api.example.com is not in the allowed hosts' },
    ])
    expect(violations.find((entry) => entry.workflowId === ids.workflows.webhook)?.issues[0]?.message).toBe('node forward: the host hooks.example.com is not in the allowed hosts')
    expect(violations.some((entry) => entry.workflowId === ids.workflows.receipt)).toBe(false)
  })

  it('accepts an exact host and a wildcard, and lists nothing that they cover', async () => {
    const env = world()
    await env.client.request('saveRule', { kind: 'allowHost', value: 'api.example.com' })
    await env.client.request('saveRule', { kind: 'allowHost', value: '*.example.com' })
    expect((await env.client.request('checkRules', {})).violations).toEqual([])
  })

  it('does not let a wildcard of another domain cover them', async () => {
    const env = world()
    await env.client.request('saveRule', { kind: 'allowHost', value: '*.example.org' })
    expect((await env.client.request('checkRules', {})).violations.length).toBeGreaterThan(0)
  })

  it('lets a wildcard cover subdomains and not the bare domain', async () => {
    const bare = workflowOf('Bare domain', [node('call', 'http.request@1', { url: 'https://example.com/ping', method: 'GET' })], [])
    const env = createFakeWorld({ workflows: [{ id: 'wf-bare', workflow: bare }], hostOptions: { restartDelayMs: 0 } })
    await env.client.request('saveRule', { kind: 'allowHost', value: '*.example.com' })
    expect((await env.client.request('checkRules', {})).violations).toEqual([
      { workflowId: 'wf-bare', name: 'Bare domain', issues: [{ stage: 3, pointer: '/nodes/0/config/url', code: 'rule_violation', message: 'node call: the host example.com is not in the allowed hosts' }] },
    ])
  })

  it('leaves a URL it cannot read and nodes of other types alone', async () => {
    const odd = workflowOf(
      'Odd',
      [node('template', 'http.request@1', { url: '{{previous.output.url}}', method: 'GET' }), node('file', 'csv.append@1', { url: 'https://other.example.org/x', file: '/tmp/a.csv', row: [] }), node('ftp', 'http.request@1', { url: 'ftp://other.example.org/x', method: 'GET' })],
      [],
    )
    const env = createFakeWorld({ workflows: [{ id: 'wf-odd', workflow: odd }], hostOptions: { restartDelayMs: 0 } })
    await env.client.request('saveRule', { kind: 'allowHost', value: 'api.example.com' })
    expect((await env.client.request('checkRules', {})).violations).toEqual([])
  })

  it('still lists a forbidden node next to a host that is not allowed', async () => {
    const env = world()
    await env.client.request('saveRule', { kind: 'forbidNode', value: 'http.request' })
    await env.client.request('saveRule', { kind: 'allowHost', value: 'other.example.org' })
    const entry = (await env.client.request('checkRules', {})).violations.find((violation) => violation.workflowId === ids.workflows.branching)
    expect(entry?.issues.map((issue) => issue.pointer)).toEqual(['/nodes/1/type'])
  })
})
