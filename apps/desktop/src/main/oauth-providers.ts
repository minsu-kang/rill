import type { OAuthProvider } from '../shared/host-api'

export interface OAuthProviderConfig {
  readonly label: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string | undefined
  readonly userinfoUrl: string
  readonly scopes: readonly string[]
  readonly nodeScopes: Readonly<Record<string, readonly string[]>>
  readonly authorizeParams: Readonly<Record<string, string>>
  readonly redirectHost: 'localhost' | '127.0.0.1'
  readonly clientSecret: 'optional' | 'never'
  readonly accountFields: readonly string[]
  readonly scopePrefix: string
  readonly notes: Readonly<Record<string, string>>
}

export const OAUTH_PROVIDER_CONFIGS: Readonly<Record<OAuthProvider, OAuthProviderConfig>> = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'],
    nodeScopes: { 'google.sheets.append': ['https://www.googleapis.com/auth/spreadsheets'] },
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    redirectHost: '127.0.0.1',
    clientSecret: 'optional',
    accountFields: ['email', 'name'],
    scopePrefix: '',
    notes: {
      authorizeUrl: 'Documented Google OAuth 2.0 endpoint for installed apps; not called by this project.',
      tokenUrl: 'Documented token endpoint; takes a form body and answers JSON; not called by this project.',
      revokeUrl: 'Documented revoke endpoint; the app revokes the refresh token on Disconnect and ignores any error.',
      userinfoUrl: 'Documented OpenID Connect userinfo endpoint; needs the openid and email scopes; failure leaves the account shown without a name.',
      scopes: 'openid and email are for the account name; spreadsheets is the one data scope of google.sheets.append.',
      nodeScopes: 'Each Google node type with the data scopes it needs; the sign-in refuses a grant that lacks them.',
      authorizeParams: 'access_type=offline and prompt=consent make Google return a refresh token every time.',
      redirectHost: 'A Desktop-app client accepts any loopback port, so nothing is registered in the console.',
      clientSecret: 'Google issues a secret for a Desktop client and treats it as not confidential; it is sent when the user entered one.',
      accountFields: 'The first of these fields in the userinfo answer is the shown account.',
      scopePrefix: 'Google returns scopes as full URLs; the check compares them as returned.',
    },
  },
  microsoft: {
    label: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    revokeUrl: undefined,
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['offline_access', 'User.Read', 'Files.ReadWrite'],
    nodeScopes: { 'microsoft.excel.append': ['Files.ReadWrite'] },
    authorizeParams: { prompt: 'select_account' },
    redirectHost: 'localhost',
    clientSecret: 'never',
    accountFields: ['displayName', 'mail', 'userPrincipalName'],
    scopePrefix: 'https://graph.microsoft.com/',
    notes: {
      authorizeUrl: 'Documented Microsoft identity platform v2 endpoint on the common tenant; not called by this project.',
      tokenUrl: 'Documented v2 token endpoint; a public client sends no secret; not called by this project.',
      revokeUrl: 'Microsoft has no per-token revoke endpoint for this flow; Disconnect is local and the user removes access on their account page.',
      userinfoUrl: 'Documented Graph endpoint for the signed-in user; needs User.Read.',
      scopes: 'offline_access makes Microsoft return a refresh token; User.Read is for the account name; Files.ReadWrite is the data scope of microsoft.excel.append.',
      nodeScopes: 'Each Microsoft node type with the data scopes it needs; the sign-in refuses a grant that lacks them.',
      authorizeParams: 'prompt=select_account lets the user pick the account instead of reusing the browser session silently.',
      redirectHost: 'The console registers http://localhost and the port is ignored for loopback addresses.',
      clientSecret: 'A Mobile and desktop application registration is a public client; no secret is sent or accepted.',
      accountFields: 'The first of these fields in the Graph answer is the shown account.',
      scopePrefix: 'The granted scope may come back as short names or prefixed with the Graph resource; the check ignores this prefix.',
    },
  },
}

export function requiredScopes(provider: OAuthProvider): string[] {
  const all = Object.values(OAUTH_PROVIDER_CONFIGS[provider].nodeScopes).flat()
  return [...new Set(all)]
}

export function normalizeScope(provider: OAuthProvider, scope: string): string {
  const { scopePrefix } = OAUTH_PROVIDER_CONFIGS[provider]
  const lower = scope.toLowerCase()
  return scopePrefix !== '' && lower.startsWith(scopePrefix) ? lower.slice(scopePrefix.length) : lower
}

export function grantsRequiredScopes(provider: OAuthProvider, granted: string): boolean {
  const have = new Set(granted.split(/\s+/).filter((part) => part !== '').map((part) => normalizeScope(provider, part)))
  return requiredScopes(provider).every((scope) => have.has(normalizeScope(provider, scope)))
}

export function redirectUri(provider: OAuthProvider, port: number): string {
  return `http://${OAUTH_PROVIDER_CONFIGS[provider].redirectHost}:${port}/oauth/callback`
}
