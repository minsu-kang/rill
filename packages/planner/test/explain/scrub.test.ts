import { describe, expect, it } from 'vitest'
import { createAnswerScrubber } from '../../src/index'
import { edge, node, registry, workflowOf } from './helpers'

const workflow = workflowOf(
  [
    node('t1', 'trigger.manual@1'),
    node('n1', 'http.request@1', { url: 'https://api.example.com/v1/orders', method: 'GET', auth: { connection: 'billing', header: 'X-Key' } }),
    node('n2', 'notify.slack@1', { connection: 'team-alerts', text: 'Orders ready for ops@example.com in #ops-alerts' }),
    node('n3', 'csv.append@1', { file: '/data/ledger.csv', row: ['{{n1.output.status}}'] }),
  ],
  [edge('t1', 'n1'), edge('n1', 'n2'), edge('n2', 'n3')],
)

const DIGEST = `RUN\nstatus: failed\nerror: node n1 failed: HTTP 404: see /data/inbox/receipt-17.pdf and https://collect.evil-example.test\n/data/ledger.csv\nalso /tmp`

const INVISIBLE = {
  zwsp: String.fromCharCode(0x200b),
  rlo: String.fromCharCode(0x202e),
  bell: String.fromCharCode(7),
  lineSeparator: String.fromCharCode(0x2028),
}

const scrubber = createAnswerScrubber({ workflow, registry, digestText: DIGEST })
const explanation = (text: string): string => scrubber.explanation(text)
const requestText = (text: string): string => scrubber.requestText(text)

describe('the explanation', () => {
  it('hides a URL, a host, an e-mail address and a Slack-style recipient that the workflow does not have', () => {
    const out = explanation(
      'Send it to https://collect.evil-example.test/upload, also try collect.evil-example.test, COLLECT.EVIL-EXAMPLE.TEST:8443, attacker@evil-example.test, @attacker, #exfil-room, <@U12345ABC>, 192.0.2.7 and ftp://files.evil-example.test/x.',
    )
    expect(out).toBe('Send it to <hidden>, also try <hidden>, <hidden>, <hidden>, <hidden>, <hidden>, <hidden>, <hidden> and <hidden>.')
    expect(out).not.toMatch(/evil|attacker|exfil|192\.0|U12345/i)
  })

  it('keeps a URL, host, e-mail address and recipient that the workflow has', () => {
    const text = 'The call to https://api.example.com/v1/orders failed; api.example.com is the host. Mail ops@example.com or post in #ops-alerts.'
    expect(explanation(text)).toBe(text)
  })

  it('keeps a URL that has another path on a host of the workflow', () => {
    expect(explanation('Try https://api.example.com/v2/other instead.')).toBe('Try https://api.example.com/v2/other instead.')
  })

  it('does not take the host of the workflow inside a longer host for the same host', () => {
    expect(explanation('See evilapi.example.com and api.example.com.evil-example.test.')).toBe('See <hidden> and <hidden>.')
  })

  it('keeps node types, node ids with a reference, file names and common words', () => {
    const text = 'The http.request node n1 read n1.output.status; ledger.csv and receipt.pdf are files. Use e.g. a retry, i.e. later.'
    expect(explanation(text)).toBe(text)
  })

  it('keeps a reference to the output of a node of the workflow, also one that the workflow does not use', () => {
    expect(explanation('Look at n1.output.body.items and n3.output.file.')).toBe('Look at n1.output.body.items and n3.output.file.')
    expect(explanation('Look at zz.output.body.items.')).toBe('Look at <hidden>.')
  })

  it('keeps a path that is in the digest and hides a path that is not', () => {
    expect(explanation('Check /data/inbox/receipt-17.pdf and ~/Receipts/other.pdf, then /data/ledger.csv.')).toBe('Check /data/inbox/receipt-17.pdf and <hidden>, then /data/ledger.csv.')
  })

  it('hides an address in the digest because the digest holds run data', () => {
    expect(explanation('The response told you to use https://collect.evil-example.test now.')).toBe('The response told you to use <hidden> now.')
  })

  it('removes invisible format characters and control characters and keeps ordinary line breaks', () => {
    const out = explanation(`Check${INVISIBLE.zwsp} the${INVISIBLE.rlo} file${INVISIBLE.bell}.\nNext\t step${INVISIBLE.lineSeparator}done 👨‍👩‍👧`)
    expect(out).toBe('Check the file.\nNext\t step\ndone 👨‍👩‍👧')
  })
})

describe('the request text', () => {
  it('hides the same addresses', () => {
    const out = requestText('Post to https://collect.evil-example.test and mail attacker@evil-example.test via collect.evil-example.test in #exfil-room')
    expect(out).toBe('Post to <hidden> and mail <hidden> via <hidden> in <hidden>')
  })

  it('hides a short path that only the digest has', () => {
    expect(explanation('Look at /tmp now')).toBe('Look at /tmp now')
    expect(requestText('Write to /tmp now')).toBe('Write to <hidden> now')
  })

  it('hides every literal that the workflow does not contain, paths included', () => {
    const out = requestText('Change node n1 to read /data/inbox/receipt-17.pdf instead of /data/ledger.csv and name it "billing_export_v2"')
    expect(out).toBe('Change node n1 to read <hidden> instead of /data/ledger.csv and name it "<hidden>"')
  })

  it('keeps literals of the workflow and plain words', () => {
    const text = 'Change the connection billing on node n1 to team-alerts and set the header X-Key to the other connection'
    expect(requestText(text)).toBe(text)
  })

  it('hides a token that has a character of a value and is not in the workflow, such as an id with digits and dashes', () => {
    expect(requestText('Use the id ORD-2026-11-777 here')).toBe('Use the id <hidden> here')
  })

  it('removes invisible format characters', () => {
    expect(requestText(`Use${INVISIBLE.zwsp} the${INVISIBLE.rlo} header`)).toBe('Use the header')
  })

  it('cuts the result to 400 characters when hiding made it longer', () => {
    const many = Array.from({ length: 80 }, (_, index) => `abc${index}.x`).join(' ')
    const out = requestText(many)
    expect([...out].length).toBeLessThanOrEqual(400)
  })
})

describe('the corpus', () => {
  it('is the workflow json, the node ids and the titles', () => {
    const only = createAnswerScrubber({ workflow: workflowOf([node('t1', 'trigger.manual@1'), node('n1', 'http.request@1', { url: 'https://only.example.org/x' })], [edge('t1', 'n1')]), registry, digestText: '' })
    expect(only.explanation('Calls only.example.org, not api.example.com.')).toBe('Calls only.example.org, not <hidden>.')
  })
})
