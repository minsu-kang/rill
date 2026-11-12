import { describe, expect, it } from 'vitest'
import { MAX_DIGEST_CHARS, buildRunDigest, type ExplainStep } from '../../src/index'
import { edge, inputOf, node, runOf, step, workflowOf } from './helpers'

const lines = (text: string): string[] => text.split('\n')
const errorLines = (text: string): string[] => lines(text).filter((entry) => entry.startsWith('error: '))

describe('the caps of the texts of a digest', () => {
  it('keeps a run error of 500 characters and cuts one of 501 with the count of what was left out', () => {
    const run = (error: string) => buildRunDigest(inputOf({ run: runOf({ error }) })).text
    expect(errorLines(run('x'.repeat(500)))[0]).toBe(`error: ${'x'.repeat(500)}`)
    expect(errorLines(run('x'.repeat(501)))[0]).toBe(`error: ${'x'.repeat(500)}… 1 more characters`)
  })

  it('keeps the error of a step at 500 characters and cuts at 501', () => {
    const text = (error: string) => buildRunDigest(inputOf({ steps: [step('n1', 'failed', { error })] })).text
    expect(errorLines(text('y'.repeat(500)))[1]).toBe(`error: ${'y'.repeat(500)}`)
    expect(errorLines(text('y'.repeat(501)))[1]).toBe(`error: ${'y'.repeat(500)}… 1 more characters`)
  })

  it('keeps a workflow name of 200 characters and cuts one of 201', () => {
    const name = (value: string) => buildRunDigest(inputOf({ workflow: workflowOf([node('t1', 'trigger.manual@1')], [], value) })).text
    expect(lines(name('W'.repeat(200))).find((entry) => entry.startsWith('WORKFLOW '))).toBe(`WORKFLOW ${'W'.repeat(200)}`)
    expect(lines(name('W'.repeat(201))).find((entry) => entry.startsWith('WORKFLOW '))).toBe(`WORKFLOW ${'W'.repeat(200)}… 1 more characters`)
  })

  it('keeps the config of a node at 400 characters and cuts one of 401 to 370 with the count', () => {
    const configOfLength = (total: number): Record<string, unknown> => {
      const config: Record<string, unknown> = { a0: 'x'.repeat(150), a1: 'x'.repeat(150), a2: '' }
      config['a2'] = 'x'.repeat(total - JSON.stringify(config).length)
      expect(JSON.stringify(config)).toHaveLength(total)
      return config
    }
    const nodeLine = (config: Record<string, unknown>) => {
      const text = buildRunDigest(inputOf({ workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'transform@1', config)], [edge('t1', 'n1')]) })).text
      return lines(text).find((entry) => entry.startsWith('- n1 '))!
    }
    const kept = JSON.stringify(configOfLength(400))
    expect(nodeLine(configOfLength(400))).toBe(`- n1 transform@1 (Transform) config: ${kept}`)
    const cut = JSON.stringify(configOfLength(401))
    expect(nodeLine(configOfLength(401))).toBe(`- n1 transform@1 (Transform) config: ${cut.slice(0, 370)}… 31 more characters`)
  })

  it('cuts a status at 40 characters', () => {
    const text = buildRunDigest(inputOf({ run: runOf({ status: 'q'.repeat(60) }) })).text
    expect(lines(text)[1]).toBe(`status: ${'q'.repeat(40)}`)
  })
})

describe('the outline', () => {
  const ids = (count: number, size = 4): string[] => Array.from({ length: count }, (_, index) => `${'n'.repeat(size - 3)}${String(index + 1).padStart(3, '0')}`)
  const nodesOf = (names: string[]) => names.map((id) => node(id, 'delay@1', { ms: 1 }))
  const outlineOf = (names: string[], edges: ReturnType<typeof edge>[] = [], extra: Parameters<typeof inputOf>[0] = {}) =>
    buildRunDigest(inputOf({ workflow: workflowOf(nodesOf(names), edges), steps: [step(names[0]!, 'failed', { error: 'x' })], ...extra }))

  it('fits 95 lines of 39 characters, which use the 3,800 of the budget exactly, and leaves the 96th out', () => {
    const fits = outlineOf(ids(95))
    expect(lines(fits.text).filter((entry) => entry.startsWith('- n')).length).toBe(95)
    expect(fits.text).not.toContain('outline omitted')
    expect(fits.truncated).toBe(false)
    const over = outlineOf(ids(96))
    expect(lines(over.text).filter((entry) => entry.startsWith('- n')).length).toBe(95)
    expect(over.text).toContain('outline omitted: 1 nodes, 0 edges')
    expect(over.truncated).toBe(true)
  })

  it('stops at the first node that does not fit, even when a later one is short enough', () => {
    const names = ids(96)
    const nodes = nodesOf(names)
    nodes[94] = node(names[94]!, 'delay@1', { ms: 1, note: 'long '.repeat(20) })
    const digest = buildRunDigest(inputOf({ workflow: workflowOf(nodes, []), steps: [step(names[0]!, 'failed', { error: 'x' })] }))
    expect(lines(digest.text).filter((entry) => entry.startsWith('- n')).length).toBe(94)
    expect(digest.text).toContain('outline omitted: 2 nodes, 0 edges')
  })

  it('fits 35 edges of 18 characters, which use the 700 of the budget exactly, and leaves the 36th out', () => {
    const names = ids(37, 8)
    const chain = (count: number) => names.slice(0, count).slice(1).map((id, index) => edge(names[index]!, id))
    const fits = outlineOf(names.slice(0, 36), chain(36))
    expect(lines(fits.text).find((entry) => entry.startsWith('edges: '))!.split(', ')).toHaveLength(35)
    expect(fits.text).not.toContain('outline omitted')
    const over = outlineOf(names.slice(0, 37), chain(37))
    expect(lines(over.text).find((entry) => entry.startsWith('edges: '))!.split(', ')).toHaveLength(35)
    expect(over.text).toContain('outline omitted: 0 nodes, 1 edges')
    expect(over.truncated).toBe(true)
  })

  it('says so when only nodes were left out, and when only edges were', () => {
    expect(outlineOf(ids(120)).text).toMatch(/outline omitted: 25 nodes, 0 edges/)
    const names = ids(37, 8)
    expect(outlineOf(names, names.slice(1).map((id, index) => edge(names[index]!, id))).text).toMatch(/outline omitted: 0 nodes, 1 edges/)
  })

  it('cuts an edge endpoint and a label at 64 characters', () => {
    const from = 'f'.repeat(70)
    const to = 't'.repeat(70)
    const digest = buildRunDigest(inputOf({ workflow: workflowOf([node(from, 'delay@1', { ms: 1 }), node(to, 'delay@1', { ms: 1 })], [edge(from, to, 'w'.repeat(70))]), steps: [step(from, 'failed', { error: 'x' })] }))
    expect(lines(digest.text).find((entry) => entry.startsWith('edges: '))).toBe(`edges: ${'f'.repeat(64)}->${'t'.repeat(64)} [${'w'.repeat(64)}]`)
  })

  it('cuts the id of a step at 64 characters', () => {
    const id = 'i'.repeat(70)
    const digest = buildRunDigest(inputOf({ workflow: workflowOf([node(id, 'delay@1', { ms: 1 })], []), steps: [step(id, 'failed', { error: 'x' })] }))
    expect(lines(digest.text).find((entry) => entry.startsWith('STEP '))).toMatch(new RegExp(`^STEP ${'i'.repeat(64)} \\(delay@1`))
  })
})

describe('what fits', () => {
  function packed(secrets: string[] = []): { fit: ReturnType<typeof buildRunDigest>; steps: number; last: number } {
    const nodes = Array.from({ length: 70 }, (_, index) => node(`s${String(index).padStart(2, '0')}`, 'delay@1', { ms: 1 }))
    const edges = nodes.slice(1).map((entry, index) => edge(nodes[index]!.id, entry.id))
    for (let fixed = 20; fixed < 70; fixed++) {
      let fit: ReturnType<typeof buildRunDigest> | undefined
      let last = -1
      for (let width = 0; width <= 190; width++) {
        const steps: ExplainStep[] = nodes.slice(0, fixed + 1).map((entry, index) => step(entry.id, 'succeeded', { input: { t: 'i'.repeat(120) }, output: { t: 'o'.repeat(index === fixed ? width : 20) } }))
        const digest = buildRunDigest(inputOf({ workflow: workflowOf(nodes, edges), steps, secrets }))
        if (digest.omittedSteps > 0) break
        fit = digest
        last = width
      }
      if (fit !== undefined && last < 190 && last > 0) return { fit, steps: fixed + 1, last }
    }
    throw new Error('no case found')
  }

  it('packs the digest up to 12,000 characters less the room of the footer and the separator, to the character', () => {
    const { fit } = packed()
    expect(fit.chars).toBe(MAX_DIGEST_CHARS - 80 - 2)
    expect(fit.omittedSteps).toBe(0)
  })

  it('packs it the same when a short secret grows the head, because the head is counted after the secret is replaced', () => {
    const { fit } = packed(['conf'])
    expect(fit.text).toContain('<secret>ig:')
    expect(fit.chars).toBe(MAX_DIGEST_CHARS - 80 - 2)
  })
})

describe('the parts that have no steps or run out of room', () => {
  it('says that no steps were recorded, and seals a secret in that text', () => {
    const text = buildRunDigest(inputOf({ steps: [] })).text
    expect(text.endsWith('STEPS\nno steps were recorded')).toBe(true)
    expect(buildRunDigest(inputOf({ steps: [], secrets: ['steps'] })).text.endsWith('STEPS\nno <secret> were recorded')).toBe(true)
  })

  it('seals a secret in the footer that counts the steps left out', () => {
    const nodes = Array.from({ length: 60 }, (_, index) => node(`s${index}`, 'delay@1', { ms: 1 }))
    const steps = nodes.map((entry) => step(entry.id, 'succeeded', { input: { t: 'i'.repeat(150) }, output: { t: 'o'.repeat(150) } }))
    const digest = buildRunDigest(inputOf({ workflow: workflowOf(nodes, []), steps, secrets: ['omitted'] }))
    expect(digest.omittedSteps).toBeGreaterThan(0)
    expect(digest.text.endsWith(`<secret>: ${digest.omittedSteps} steps`)).toBe(true)
    expect(digest.text).not.toContain('omitted')
  })
})

describe('durations and run state', () => {
  it('shows no negative duration when the clock went back', () => {
    const text = buildRunDigest(inputOf({ run: runOf({ createdAt: 2000, startedAt: 1000, finishedAt: 500 }) })).text
    expect(text).toContain('waited: 0 ms')
    expect(text).toContain('ran: 0 ms')
  })

  it('gives the time that a step took, and none for a step that has not finished', () => {
    const text = buildRunDigest(inputOf({ steps: [step('n1', 'failed', { startedAt: 10, finishedAt: 35, error: 'x' }), step('n2', 'running', { startedAt: 10, finishedAt: null })] })).text
    expect(text).toMatch(/STEP n1 .*failed after 1 attempt, 25 ms/)
    expect(text).toMatch(/STEP n2 .*running after 1 attempt\n/)
  })

  it('has no error line for a step that has no error', () => {
    const text = buildRunDigest(inputOf({ steps: [step('n1', 'succeeded')] })).text
    expect(text.slice(text.indexOf('STEP n1'))).not.toContain('error:')
  })
})

describe('the two halves of the excerpt of a step', () => {
  const side = (input: unknown, output: unknown) => {
    const text = buildRunDigest(inputOf({ steps: [step('n1', 'failed', { input, output })] })).text
    return {
      input: lines(text).find((entry) => entry.startsWith('input: '))!.length - 'input: '.length,
      output: lines(text).find((entry) => entry.startsWith('output: '))!.length - 'output: '.length,
    }
  }
  const wide = (values: number, size: number): Record<string, string> => Object.fromEntries(Array.from({ length: values }, (_, index) => [`field${String(index).padStart(2, '0')}`, 'v'.repeat(size)]))

  it('gives a big input the room that a small output leaves', () => {
    const { input, output } = side(wide(8, 190), { small: 1 })
    expect(output).toBe('{"small":1}'.length)
    expect(input).toBeGreaterThan(1400)
  })

  it('keeps an input of up to 750 characters whole when the output is big, and gives the output the rest', () => {
    const { input, output } = side(wide(3, 190), wide(8, 190))
    expect(input).toBeGreaterThan(600)
    expect(input).toBeLessThanOrEqual(750)
    expect(output).toBeGreaterThan(800)
    expect(input + output).toBeLessThanOrEqual(1500)
  })

  it('cuts both to half when both are big', () => {
    const { input, output } = side(wide(8, 190), wide(8, 190))
    expect(input).toBeLessThanOrEqual(750)
    expect(output).toBeLessThanOrEqual(750)
    expect(input).toBeGreaterThan(700)
    expect(output).toBeGreaterThan(700)
  })
})
