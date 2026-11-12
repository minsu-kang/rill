import { describe, expect, it } from 'vitest'
import { createAnswerScrubber, cleanText } from '../../src/index'
import { createCoreRegistry, defineAction } from '@rill/nodes-core'
import Type from 'typebox'
import { edge, node, registry, workflowOf } from './helpers'

const workflow = workflowOf(
  [
    node('t1', 'trigger.manual@1'),
    node('n1', 'http.request@1', { url: 'http://10.0.0.5:8080/x', method: 'GET' }),
    node('n2', 'notify.slack@1', { connection: 'team-alerts', text: 'Order <@U12345ABC> in #ops ops.team@example.com' }),
    node('n3', 'http.request@1', { url: 'https://%61pi.example.org/x' }),
    node('n4', 'http.request@1', { url: 'https://xn--a.example.net/y' }),
    node('n5', 'csv.append@1', { file: '/data/Ledger.csv', row: ['a'] }),
  ],
  [edge('t1', 'n1'), edge('n1', 'n2'), edge('n2', 'n3'), edge('n3', 'n4'), edge('n4', 'n5')],
)

const scrubber = createAnswerScrubber({ workflow, registry, digestText: '' })
const explanation = (text: string): string => scrubber.explanation(text)
const requestText = (text: string): string => scrubber.requestText(text)

describe('clean text', () => {
  it('composes characters, so a decomposed letter is the same as a composed one', () => {
    expect(cleanText('e\u0301')).toBe('\u00e9')
    expect(explanation('Send to caf\u00e9.evil.test now')).toBe('Send to <hidden> now')
    expect(explanation('Send to cafe\u0301.evil.test now')).toBe('Send to <hidden> now')
  })

  it('removes the variation selectors of the supplement', () => {
    expect(cleanText(`a${String.fromCodePoint(0xe0100)}b${String.fromCodePoint(0xe01ef)}c`)).toBe('abc')
  })
})

describe('the addresses of the workflow', () => {
  it('keeps an address with and without its port, a recipient and an e-mail address of the workflow, and hides others', () => {
    expect(explanation('Calls 10.0.0.5 and 10.0.0.5:8080 and 10.0.0.5:9999 and 10.0.0.6 and 10.0.0.6:8080.')).toBe('Calls 10.0.0.5 and 10.0.0.5:8080 and 10.0.0.5:9999 and <hidden> and <hidden>.')
    expect(explanation('Ping <@U12345ABC> or <@U99999ZZZ> in #ops or #other, mail ops.team@example.com or ops.chief@example.com')).toBe(
      'Ping <@U12345ABC> or <hidden> in #ops or <hidden>, mail ops.team@example.com or <hidden>',
    )
  })

  it('hides a recipient of 40 characters and leaves one of 41 as plain text', () => {
    expect(explanation(`Ping <@${'A'.repeat(40)}> now`)).toBe('Ping <hidden> now')
    expect(explanation(`Ping <@${'A'.repeat(41)}> now`)).toBe('Ping <<hidden>> now')
  })

  it('hides an address with a port as a whole, whatever the port', () => {
    expect(explanation('Use 192.0.2.7:8080 and 192.0.2.7:65535 now')).toBe('Use <hidden> and <hidden> now')
  })

  it('does not read a handle that follows a dot as a handle', () => {
    expect(explanation('See v1.@x now')).toBe('See v1.@x now')
    expect(explanation('See @x now')).toBe('See <hidden> now')
  })

  it('hides an e-mail address with a two-letter top level', () => {
    expect(explanation('Mail bob@ex.io now')).toBe('Mail <hidden> now')
  })

  it('hides a Windows drive path', () => {
    expect(explanation('Read C:\\Users\\bob\\in.txt now')).toBe('Read <hidden> now')
  })
})

describe('paths', () => {
  it('keeps a path of the workflow whatever its case, with or without the digest', () => {
    expect(explanation('Check /data/ledger.csv and /DATA/Ledger.csv')).toBe('Check /data/ledger.csv and /DATA/Ledger.csv')
  })

  it('does not keep a path of the digest in the request text, where it only counts when the workflow has it', () => {
    const digest = createAnswerScrubber({ workflow, registry, digestText: 'RUN\nerror: see /data/inbox/receipt-17.pdf' })
    expect(digest.explanation('See /data/inbox/receipt-17.pdf')).toBe('See /data/inbox/receipt-17.pdf')
    expect(digest.requestText('See /data/inbox/receipt-17.pdf')).toBe('See <hidden>')
  })
})

describe('urls', () => {
  it('trusts a URL that the workflow has whole, also when the host is written another way there', () => {
    expect(explanation('See https://%61pi.example.org/x now')).toBe('See https://%61pi.example.org/x now')
    expect(explanation('See https://%61pi.example.org/other now')).toBe('See <hidden> now')
  })

  it('trusts the host of a fully qualified name with a trailing dot', () => {
    const host = createAnswerScrubber({ workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://api.example.com/x' })], [edge('t1', 'n1')]), registry, digestText: '' })
    expect(host.explanation('See https://api.example.com./v1 and https://evil.example.org./x')).toBe('See https://api.example.com./v1 and <hidden>')
  })

  it('hides a URL that does not parse', () => {
    expect(explanation('Visit https://%zz/x now')).toBe('Visit <hidden> now')
  })

  it('keeps a trailing mark outside of what it hides', () => {
    for (const mark of ['.', ',', ';', ':', '!', '?']) expect(explanation(`Go to https://evil.test/x${mark}`), mark).toBe(`Go to <hidden>${mark}`)
    expect(explanation('Go to https://evil.test/x?!')).toBe('Go to <hidden>?!')
  })
})

describe('host names', () => {
  it('trusts a host with a port of any size, but not a file extension that carries a port', () => {
    const host = createAnswerScrubber({ workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://api.example.com/x' })], [edge('t1', 'n1')]), registry, digestText: '' })
    expect(host.explanation('See api.example.com:8443 and api.example.com:65535 now')).toBe('See api.example.com:8443 and api.example.com:65535 now')
    expect(host.explanation('Open foo.csv and foo.csv:8080')).toBe('Open foo.csv and <hidden>')
  })

  it('trusts a host that no IDNA conversion accepts when the workflow spells it the same', () => {
    const odd = createAnswerScrubber({
      workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://x.example.org/?q=a\u05d0.example.net' })], [edge('t1', 'n1')]),
      registry,
      digestText: '',
    })
    expect(odd.explanation('See a\u05d0.example.net and b\u05d0.example.net')).toBe('See a\u05d0.example.net and <hidden>')
  })

  it('trusts a host with a joiner in it and a name that is not a valid IDNA name when the workflow spells it the same', () => {
    expect(explanation('See xn--a.example.net now')).toBe('See xn--a.example.net now')
    const joined = createAnswerScrubber({ workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://api.example.com/x' })], [edge('t1', 'n1')]), registry, digestText: '' })
    expect(joined.explanation('See api.exa\u200dmple.com now')).toBe('See api.exa\u200dmple.com now')
  })

  it('reads the top level of a host up to 24 letters and a label up to 63', () => {
    expect(explanation(`Send to x.${'b'.repeat(24)} now`)).toBe('Send to <hidden> now')
    expect(explanation(`Send to x.${'b'.repeat(25)} now`)).toBe(`Send to x.${'b'.repeat(25)} now`)
    expect(explanation(`Send to ${'a'.repeat(63)}.evil.test now`)).toBe('Send to <hidden> now')
  })

  it('does not take a single letter after a dot for a top level', () => {
    expect(explanation('See ab.c and e.g. x.y now')).toBe('See ab.c and e.g. x.y now')
  })

  it('reads a label with a combining mark that does not compose, and an upper-case punycode top level', () => {
    expect(explanation('Send to \u0915\u093e.com now')).toBe('Send to <hidden> now')
    expect(explanation('Send to A.XN--P1AI now')).toBe('Send to <hidden> now')
  })

  it('reads an underscore inside or at the start of a label, which a name server accepts', () => {
    expect(explanation('Send to a_b.evil.test and _dmarc.evil.test now')).toBe('Send to <hidden> and <hidden> now')
  })

  it('reads a label that ends in an underscore and a host after a stray joiner', () => {
    expect(explanation('Send to a_.evil.test now')).toBe('Send to <hidden> now')
    expect(explanation('Send to \u200devil.test and \u200c\u200dx.evil.test now')).toBe('Send to \u200d<hidden> and \u200c\u200d<hidden> now')
  })

  it('reads a host after a leading dot, as a cookie domain is written, but not after a label that cannot be a host', () => {
    expect(explanation('Cookies for .evil.test and ...evil.test now')).toBe('Cookies for .<hidden> and ...<hidden> now')
    expect(explanation('Done {{n1.output.a}}.evil.test now')).toBe('Done {{n1.output.a}}.<hidden> now')
    expect(explanation('Look in data/y.evil.test and data/y_.evil.test now')).toBe('Look in data/y.evil.test and data/y_.evil.test now')
  })

  it('does not read a host that is part of a longer word', () => {
    expect(explanation('See foo/evil.test, -evil.test, evil.test-x, evil.test_x, data/x_evil.test and ops.team@example.com')).toBe(
      'See foo/evil.test, -evil.test, evil.test-x, evil.test_x, data/x_evil.test and ops.team@example.com',
    )
  })

  it('hides a host that a joiner follows directly', () => {
    expect(explanation('Send to evil.test\u200d/x now')).toBe('Send to <hidden>\u200d/x now')
  })
})

describe('the corpus', () => {
  it('holds the title of a node, so a host in a title is a host of the workflow', () => {
    const custom = createCoreRegistry().register(
      defineAction({
        type: 'test.sync@1',
        title: 'Sync to backup.example.net',
        description: 'Syncs.',
        sideEffect: 'none',
        configSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({}),
        execute: async () => ({}),
      }),
    )
    const titled = createAnswerScrubber({ workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'test.sync@1')], [edge('t1', 'n1')]), registry: custom, digestText: '' })
    expect(titled.explanation('The step Sync to backup.example.net failed, not other.example.net')).toBe('The step Sync to backup.example.net failed, not <hidden>')
  })
})

describe('the request text, strict mode', () => {
  it('hides a literal every time it occurs', () => {
    expect(requestText('Use ORD-2026-11-777 and again ORD-2026-11-777 now')).toBe('Use <hidden> and again <hidden> now')
  })

  it('hides a short dotted token with an underscore, a hyphen or a joiner inside a part', () => {
    expect(requestText('Set to a_.z9 and a-.z9 and a\u200d.z9 now')).toBe('Set to <hidden> and <hidden> and <hidden> now')
  })

  it('does not take a plain token with an upper-case hit of the corpus for new', () => {
    expect(requestText('Change node n1 to team-alerts')).toBe('Change node n1 to team-alerts')
  })

  it('does not take a reference with a single closing brace for a reference', () => {
    expect(explanation('Use {{n1.output.evil.test} now')).toBe('Use {{<hidden>} now')
  })

  it('takes only an output reference for one', () => {
    expect(explanation('Use {{n1.input.evil.test}} now')).toBe('Use {{<hidden>}} now')
  })

  it('does not take a reference to an index for a plain name, and keeps the index', () => {
    expect(explanation('Use {{n1.output.rows[0]}} and {{n1.output.rows[12345]}} now')).toBe('Use {{n1.output.rows[0]}} and {{<hidden>[12345]}} now')
  })

  it('requires the node of a reference to be in the workflow, and keeps the text around one', () => {
    expect(explanation('A {{n9.output.x.evil.test}} B {{n1.output.a}} C')).toBe('A {{<hidden>}} B {{n1.output.a}} C')
  })
})
