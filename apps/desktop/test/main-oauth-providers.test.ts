// @vitest-environment node
import { createCoreRegistry } from '@rill/nodes-core'
import { describe, expect, it } from 'vitest'
import { CALLBACK_PATH } from '../src/main/oauth-flow'
import { OAUTH_PROVIDER_CONFIGS, grantsRequiredScopes, normalizeScope, redirectUri, requiredScopes } from '../src/main/oauth-providers'
import { OAUTH_PROVIDERS, OAUTH_REDIRECT_REGISTRATION } from '../src/shared/host-api'

describe('provider table', () => {
  it('holds the documented Google constants', () => {
    const google = OAUTH_PROVIDER_CONFIGS.google
    expect(google.authorizeUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(google.tokenUrl).toBe('https://oauth2.googleapis.com/token')
    expect(google.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
    expect(google.userinfoUrl).toBe('https://openidconnect.googleapis.com/v1/userinfo')
    expect(google.scopes).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'])
    expect(google.authorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' })
    expect(google.redirectHost).toBe('127.0.0.1')
    expect(google.clientSecret).toBe('optional')
    expect(google.accountFields).toEqual(['email', 'name'])
  })

  it('holds the documented Microsoft constants', () => {
    const microsoft = OAUTH_PROVIDER_CONFIGS.microsoft
    expect(microsoft.authorizeUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(microsoft.tokenUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    expect(microsoft.revokeUrl).toBeUndefined()
    expect(microsoft.userinfoUrl).toBe('https://graph.microsoft.com/v1.0/me')
    expect(microsoft.scopes).toEqual(['offline_access', 'User.Read', 'Files.ReadWrite'])
    expect(microsoft.authorizeParams).toEqual({ prompt: 'select_account' })
    expect(microsoft.redirectHost).toBe('localhost')
    expect(microsoft.clientSecret).toBe('never')
    expect(microsoft.accountFields).toEqual(['displayName', 'mail', 'userPrincipalName'])
  })

  it('has a table row for every provider the host contract knows, and nothing else', () => {
    expect(Object.keys(OAUTH_PROVIDER_CONFIGS).sort()).toEqual([...OAUTH_PROVIDERS].sort())
  })

  it('has a note for every constant of every row', () => {
    for (const [provider, row] of Object.entries(OAUTH_PROVIDER_CONFIGS)) {
      const constants = Object.keys(row).filter((key) => key !== 'notes' && key !== 'label')
      expect(Object.keys(row.notes).sort(), provider).toEqual(constants.sort())
      for (const note of Object.values(row.notes)) expect(note.trim().length, provider).toBeGreaterThan(20)
    }
  })

  it('uses https for every endpoint', () => {
    for (const row of Object.values(OAUTH_PROVIDER_CONFIGS)) {
      for (const url of [row.authorizeUrl, row.tokenUrl, row.userinfoUrl, ...(row.revokeUrl === undefined ? [] : [row.revokeUrl])]) expect(url.startsWith('https://')).toBe(true)
    }
  })
})

describe('node types and scopes', () => {
  const nodeTypes = createCoreRegistry()
    .list()
    .map((def) => def.type.replace(/@\d+$/, ''))

  for (const provider of OAUTH_PROVIDERS) {
    it(`maps every ${provider} node type to its scopes and every mapped type to a node`, () => {
      const prefix = `${provider}.`
      const nodes = nodeTypes.filter((type) => type.startsWith(prefix)).sort()
      expect(Object.keys(OAUTH_PROVIDER_CONFIGS[provider].nodeScopes).sort()).toEqual(nodes)
      expect(nodes.length).toBeGreaterThan(0)
    })

    it(`requests every scope that a ${provider} node needs`, () => {
      const row = OAUTH_PROVIDER_CONFIGS[provider]
      expect(requiredScopes(provider).length).toBeGreaterThan(0)
      for (const scope of requiredScopes(provider)) expect(row.scopes).toContain(scope)
    })
  }

  it('lists no node type of one provider under the other', () => {
    expect(Object.keys(OAUTH_PROVIDER_CONFIGS.google.nodeScopes).every((type) => type.startsWith('google.'))).toBe(true)
    expect(Object.keys(OAUTH_PROVIDER_CONFIGS.microsoft.nodeScopes).every((type) => type.startsWith('microsoft.'))).toBe(true)
  })

  it('requires only the data scopes, so a refusal of the account name scopes still connects', () => {
    expect(requiredScopes('google')).toEqual(['https://www.googleapis.com/auth/spreadsheets'])
    expect(requiredScopes('microsoft')).toEqual(['Files.ReadWrite'])
  })
})

describe('grantsRequiredScopes', () => {
  it('accepts a Google grant that lists the spreadsheets scope, in any order and with the normalized email scope', () => {
    expect(grantsRequiredScopes('google', 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets')).toBe(true)
    expect(grantsRequiredScopes('google', 'https://www.googleapis.com/auth/spreadsheets')).toBe(true)
  })

  it('refuses a Google grant without it, an empty grant and a lookalike', () => {
    expect(grantsRequiredScopes('google', 'openid email')).toBe(false)
    expect(grantsRequiredScopes('google', '')).toBe(false)
    expect(grantsRequiredScopes('google', 'https://www.googleapis.com/auth/spreadsheets.readonly')).toBe(false)
    expect(grantsRequiredScopes('google', 'https://www.googleapis.com/auth/spreadsheetsX')).toBe(false)
  })

  it('accepts a Microsoft grant with short names or Graph-prefixed names, ignoring case', () => {
    expect(grantsRequiredScopes('microsoft', 'User.Read Files.ReadWrite profile openid email')).toBe(true)
    expect(grantsRequiredScopes('microsoft', 'https://graph.microsoft.com/Files.ReadWrite https://graph.microsoft.com/User.Read')).toBe(true)
    expect(grantsRequiredScopes('microsoft', 'files.readwrite')).toBe(true)
  })

  it('refuses a Microsoft grant that has only read access', () => {
    expect(grantsRequiredScopes('microsoft', 'User.Read Files.Read')).toBe(false)
    expect(grantsRequiredScopes('microsoft', 'Files.ReadWrite.All')).toBe(false)
    expect(grantsRequiredScopes('microsoft', '   ')).toBe(false)
  })

  it('does not strip the Graph prefix from Google scopes', () => {
    expect(normalizeScope('google', 'https://graph.microsoft.com/Files.ReadWrite')).toBe('https://graph.microsoft.com/files.readwrite')
    expect(normalizeScope('microsoft', 'https://graph.microsoft.com/Files.ReadWrite')).toBe('files.readwrite')
  })
})

describe('the redirect address that the card shows', () => {
  it('is the address that the sign-in sends for Microsoft without the port and with the path, and there is none for Google, whose loopback address needs no registration', () => {
    expect(OAUTH_REDIRECT_REGISTRATION.microsoft).toBe('http://localhost/oauth/callback')
    const sent = new URL(redirectUri('microsoft', 51234))
    expect(sent.port).toBe('51234')
    sent.port = ''
    expect(sent.href).toBe(new URL(OAUTH_REDIRECT_REGISTRATION.microsoft!).href)
    expect(new URL(OAUTH_REDIRECT_REGISTRATION.microsoft!).pathname).toBe(CALLBACK_PATH)
    expect(OAUTH_REDIRECT_REGISTRATION.google).toBeUndefined()
    expect(OAUTH_PROVIDER_CONFIGS.google.redirectHost).toBe('127.0.0.1')
  })
})

describe('redirectUri', () => {
  it('uses 127.0.0.1 for Google and localhost for Microsoft, with the port and the callback path', () => {
    expect(redirectUri('google', 49152)).toBe('http://127.0.0.1:49152/oauth/callback')
    expect(redirectUri('microsoft', 49153)).toBe('http://localhost:49153/oauth/callback')
  })
})
