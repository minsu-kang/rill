import { homedir } from 'node:os'
import type { Workflow } from '@rill/dsl'
import { describe, expect, it } from 'vitest'
import { loadPlannerData } from '../src/suites/planner/cases'
import { CONNECTION_KINDS, DEFAULT_ATTACHMENTS_ROOT, attachmentsRootOf, buildPlanRequest, connectionsOf, withDemoHome } from '../src/suites/planner/context'

const data = loadPlannerData()
const spec = (id: string) => {
  const found = data.cases.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

describe('CONNECTION_KINDS', () => {
  it('covers every connection name of the cases and agrees with how the gold workflows use them', () => {
    const names = new Set(data.cases.flatMap((entry) => entry.context.connections))
    expect([...names].sort()).toEqual(Object.keys(CONNECTION_KINDS).sort())
    for (const [key, workflow] of Object.entries(data.references) as [string, Workflow][]) {
      for (const node of workflow.nodes) {
        const config = node.config
        const auth = config['auth']
        if (node.type === 'notify.slack@1') expect(CONNECTION_KINDS[String(config['connection'])], key).toBe('slack')
        if (node.type === 'http.request@1' && auth !== null && typeof auth === 'object') {
          expect(CONNECTION_KINDS[String((auth as { connection?: string }).connection)], key).toBe('http')
        }
      }
    }
  })
  it('refuses a name it has no kind for', () => {
    expect(() => connectionsOf(['mystery'])).toThrow('no connection kind is known for mystery')
    expect(connectionsOf(['slack-ops', 'crm-token'])).toEqual([
      { name: 'slack-ops', kind: 'slack' },
      { name: 'crm-token', kind: 'http' },
    ])
  })
})

describe('attachmentsRootOf', () => {
  it('lives inside the first allowed folder, else under the demo home', () => {
    expect(attachmentsRootOf(['/Users/demo/Receipts', '/Users/demo/Other'])).toBe('/Users/demo/Receipts/.attachments')
    expect(attachmentsRootOf([])).toBe(DEFAULT_ATTACHMENTS_ROOT)
  })
})

describe('buildPlanRequest', () => {
  it('turns an easy case into a first message with the case effort and no selection', () => {
    const request = buildPlanRequest(spec('easy-03-webhook-to-slack'), [])
    expect(request).toMatchObject({
      text: spec('easy-03-webhook-to-slack').prompt,
      turns: [],
      attachments: [],
      effort: spec('easy-03-webhook-to-slack').effort,
      context: { connections: [{ name: 'slack-ops', kind: 'slack' }], allowedRoots: spec('easy-03-webhook-to-slack').context.allowedFolders },
    })
    expect(request.selection).toBeUndefined()
    expect(request.context.existingWorkflow).toBeUndefined()
  })
  it('lets the caller override the effort', () => {
    expect(buildPlanRequest(spec('easy-03-webhook-to-slack'), [], 'xhigh').effort).toBe('xhigh')
  })
  it('puts the selected node and a copy of the existing workflow on a patch case', () => {
    const patch = spec('patch-01-change-schedule')
    const request = buildPlanRequest(patch, [])
    expect(request.selection).toEqual({ nodeId: 't1' })
    expect(request.context.existingWorkflow).toEqual(patch.context.existingWorkflow)
    expect(request.context.existingWorkflow).not.toBe(patch.context.existingWorkflow)
    expect(request.context.allowedRoots).toEqual([])
    expect(request.context.attachmentsRoot).toBe(DEFAULT_ATTACHMENTS_ROOT)
  })
  it('passes the attachment refs it is given as a copy', () => {
    const refs = [{ id: 'att-1', mediaType: 'image/png' as const, name: 'sample-1.png', bytes: 3 }]
    const request = buildPlanRequest(spec('attach-02-sample-png-english'), refs)
    expect(request.attachments).toEqual(refs)
    expect(request.attachments).not.toBe(refs)
    expect(request.context.attachmentsRoot).toBe('/Users/demo/Receipts/.attachments')
  })
})

describe('withDemoHome', () => {
  const real = process.env['HOME']

  it('makes ~ expand to the demo home while the work runs, and restores HOME after', async () => {
    const seen = await withDemoHome(() => Promise.resolve(homedir()))
    expect(seen).toBe('/Users/demo')
    expect(process.env['HOME']).toBe(real)
  })
  it('restores HOME when the work throws', async () => {
    await expect(withDemoHome(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(process.env['HOME']).toBe(real)
  })
  it('keeps the demo home until the last of several concurrent runs is done', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const first = withDemoHome(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push(`first ${homedir()}`)
    })
    const second = withDemoHome(() => Promise.resolve(order.push(`second ${homedir()}`)))
    await second
    expect(homedir()).toBe('/Users/demo')
    releaseFirst()
    await first
    expect(order).toEqual(['second /Users/demo', `first /Users/demo`])
    expect(process.env['HOME']).toBe(real)
  })
  it('removes HOME again when it was not set before', async () => {
    delete process.env['HOME']
    try {
      await withDemoHome(() => Promise.resolve())
      expect(process.env['HOME']).toBeUndefined()
    } finally {
      if (real !== undefined) process.env['HOME'] = real
    }
  })
})
