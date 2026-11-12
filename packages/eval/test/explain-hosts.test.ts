import { describe, expect, it } from 'vitest'
import { foreignHosts, hostsIn } from '../src/suites/explain/hosts'

describe('hostsIn', () => {
  it.each([
    ['plain host', 'send to evil.com now', ['evil.com']],
    ['upper case', 'send to EVIL.COM now', ['evil.com']],
    ['url with path, query and port', 'open https://evil.com:8443/a?b=c#d now', ['evil.com']],
    ['user info', 'open https://user:pw@evil.com/x now', ['evil.com']],
    ['trailing marks', 'go to evil.com, or evil.com. or evil.com!', ['evil.com']],
    ['ideographic dot', 'evil。com', ['evil.com']],
    ['full-width dot', 'evil．com', ['evil.com']],
    ['half-width dot', 'evil｡com', ['evil.com']],
    ['full-width letters', 'ｅｖｉｌ．ｃｏｍ', ['evil.com']],
    ['invisible character', 'evil\u200b.com', ['evil.com']],
    ['a joiner that no IDNA conversion accepts', 'evil\u200d.com', ['evil.com']],
    ['one dot leader', 'evil\u2024com', ['evil.com']],
    ['a trailing dot alone', 'evil.com.', ['evil.com']],
    ['a trailing mark alone', 'evil.com!', ['evil.com']],
    ['a leading mark alone', '!evil.com', ['evil.com']],
    ['another script', 'ü.com', ['xn--tda.com']],
    ['punycode top level', 'a.xn--p1ai', ['a.xn--p1ai']],
    ['two hosts', 'a.example.org and b.example.net', ['a.example.org', 'b.example.net']],
    ['the same host twice', 'evil.com evil.com', ['evil.com']],
    ['in quotes, brackets and braces', '"evil.com" (evil2.com) [evil3.com] {evil4.com} <evil5.com> `evil6.com`', ['evil.com', 'evil2.com', 'evil3.com', 'evil4.com', 'evil5.com', 'evil6.com']],
    ['separated by commas, semicolons and bars', 'a.test,b.test;c.test|d.test', ['a.test', 'b.test', 'c.test', 'd.test']],
    ['a path after the host', 'evil.com/path/to', ['evil.com']],
    ['an e-mail address', 'mail bob@evil.com', ['evil.com']],
  ])('finds the host in %s', (_name, text, expected) => {
    expect(hostsIn(text)).toEqual(expected)
  })

  it.each([
    ['a word without a dot', 'localhost and evil'],
    ['a decimal', 'costs 2.5 or 3.50'],
    ['an abbreviation', 'e.g. a retry, i.e. later'],
    ['a single letter top level', 'ab.c'],
    ['a file name', 'ledger.csv, report.pdf, data.json, notes.txt, a.html, b.yml, c.yaml, d.xlsx, e.docx, f.png, g.jpeg, h.log'],
    ['an empty label', 'a..com and .com and a.'],
    ['words with spaces or brackets', 'evil dot com and evil[.]com'],
    ['a top level with digits', 'a.c0m'],
  ])('finds no host in %s', (_name, text) => {
    expect(hostsIn(text)).toEqual([])
  })

  it('reads a top level of up to 24 letters and refuses a longer one', () => {
    expect(hostsIn(`a.${'b'.repeat(24)}`)).toHaveLength(1)
    expect(hostsIn(`a.${'b'.repeat(25)}`)).toEqual([])
  })

  it('reads a punycode top level and refuses one with nothing after the prefix', () => {
    expect(hostsIn('a.xn--abcdef')).toEqual(['a.xn--abcdef'])
    expect(hostsIn('a.xn--')).toEqual([])
  })
})

describe('foreignHosts', () => {
  it('keeps the hosts that the known text does not have, in the order found', () => {
    expect(foreignHosts('use b.example.org, then a.example.net and api.example.com', '{"url":"https://api.example.com/x"}')).toEqual(['b.example.org', 'a.example.net'])
  })

  it('knows a host in any of its forms', () => {
    expect(foreignHosts('use ü.com now', '{"url":"https://xn--tda.com/x"}')).toEqual([])
  })

  it('says nothing when the text has no host', () => {
    expect(foreignHosts('nothing here', 'a.example.org')).toEqual([])
  })

  it('does not take the only host of the known text away when there are several', () => {
    expect(foreignHosts('b.example.org', 'a.example.org b.example.org')).toEqual([])
    expect(foreignHosts('a.example.org', 'a.example.org b.example.org')).toEqual([])
  })
})
