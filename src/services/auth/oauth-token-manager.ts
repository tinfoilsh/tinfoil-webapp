import { OAUTH } from '@/config'
import {
  AUTH_OAUTH_ACCESS_TOKEN,
  AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_AT,
  AUTH_OAUTH_PENDING_CODE_VERIFIER,
  AUTH_OAUTH_PENDING_REDIRECT_URI,
  AUTH_OAUTH_PENDING_RETURN_TO,
  AUTH_OAUTH_PENDING_STATE,
  AUTH_OAUTH_REFRESH_TOKEN,
} from '@/constants/storage-keys'

type StoredAccessToken = {
  token: string
  expiresAt: number
}

type TokenResponse = {
  accessToken: string
  expiresIn: number
  refreshToken: string | null
}

class OAuthTokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(code || `OAuth token request failed with ${status}`)
    this.name = 'OAuthTokenEndpointError'
  }
}

export class OAuthRedirectStartedError extends Error {
  constructor() {
    super('OAuth authorization redirect started')
    this.name = 'OAuthRedirectStartedError'
  }
}

let cachedAccessToken: StoredAccessToken | null = null
let refreshInFlight: Promise<string | null> | null = null
let authorizationInFlight = false

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readLocal(key: string): string | null {
  return getLocalStorage()?.getItem(key) ?? null
}

function writeLocal(key: string, value: string): void {
  getLocalStorage()?.setItem(key, value)
}

function removeLocal(key: string): void {
  getLocalStorage()?.removeItem(key)
}

function readSession(key: string): string | null {
  return getSessionStorage()?.getItem(key) ?? null
}

function writeSession(key: string, value: string): void {
  getSessionStorage()?.setItem(key, value)
}

function removeSession(key: string): void {
  getSessionStorage()?.removeItem(key)
}

function isConfigured(): boolean {
  return OAUTH.CLIENT_ID.trim().length > 0
}

function isExpiring(expiresAt: number): boolean {
  return Date.now() > expiresAt - OAUTH.ACCESS_TOKEN_EXPIRY_BUFFER_MS
}

function readStoredAccessToken(): string | null {
  if (cachedAccessToken && !isExpiring(cachedAccessToken.expiresAt)) {
    return cachedAccessToken.token
  }

  const token = readSession(AUTH_OAUTH_ACCESS_TOKEN)
  const expiresAt = Number(readSession(AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_AT))
  if (!token || !Number.isFinite(expiresAt) || isExpiring(expiresAt)) {
    clearOAuthAccessTokenCache()
    return null
  }

  cachedAccessToken = { token, expiresAt }
  return token
}

function storeTokenResponse(response: TokenResponse): string {
  const expiresAt = Date.now() + response.expiresIn * 1000
  cachedAccessToken = { token: response.accessToken, expiresAt }
  writeSession(AUTH_OAUTH_ACCESS_TOKEN, response.accessToken)
  writeSession(AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_AT, String(expiresAt))
  if (response.refreshToken) {
    writeLocal(AUTH_OAUTH_REFRESH_TOKEN, response.refreshToken)
  }
  return response.accessToken
}

function parseTokenResponse(payload: unknown): TokenResponse {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid OAuth token response')
  }

  const record = payload as Record<string, unknown>
  const tokenType = record.token_type
  if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
    throw new Error('Unsupported OAuth token type')
  }

  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth token response did not include an access token')
  }

  const expiresIn =
    typeof record.expires_in === 'number'
      ? record.expires_in
      : Number(record.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth token response did not include a valid expiry')
  }

  const refreshToken =
    typeof record.refresh_token === 'string' && record.refresh_token.length > 0
      ? record.refresh_token
      : null

  return { accessToken, expiresIn, refreshToken }
}

async function requestToken(params: URLSearchParams): Promise<string> {
  const response = await fetch(OAUTH.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const code =
      body && typeof body === 'object'
        ? ((body as Record<string, unknown>).error as string | undefined)
        : undefined
    throw new OAuthTokenEndpointError(response.status, code ?? null)
  }

  return storeTokenResponse(parseTokenResponse(body))
}

function createTokenRequestParams(
  grantType: 'authorization_code' | 'refresh_token',
): URLSearchParams {
  return new URLSearchParams({
    grant_type: grantType,
    client_id: OAUTH.CLIENT_ID,
  })
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = readLocal(AUTH_OAUTH_REFRESH_TOKEN)
  if (!refreshToken) return null

  const params = createTokenRequestParams('refresh_token')
  params.set('refresh_token', refreshToken)

  try {
    return await requestToken(params)
  } catch (error) {
    if (
      error instanceof OAuthTokenEndpointError &&
      (error.code === 'invalid_grant' || error.code === 'invalid_client')
    ) {
      clearOAuthTokens()
      return null
    }
    throw error
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}

function getRedirectUri(): string {
  if (OAUTH.REDIRECT_URI) return OAUTH.REDIRECT_URI
  if (typeof window === 'undefined') {
    throw new Error('Cannot start OAuth authorization outside the browser')
  }
  return `${window.location.origin}${OAUTH.CALLBACK_PATH}`
}

function currentReturnPath(): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function safeReturnPath(path: string | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    return '/'
  }
  return path
}

function clearPendingAuthorization(): void {
  removeSession(AUTH_OAUTH_PENDING_CODE_VERIFIER)
  removeSession(AUTH_OAUTH_PENDING_REDIRECT_URI)
  removeSession(AUTH_OAUTH_PENDING_RETURN_TO)
  removeSession(AUTH_OAUTH_PENDING_STATE)
  authorizationInFlight = false
}

async function startAuthorization(
  returnTo = currentReturnPath(),
): Promise<never> {
  if (!isConfigured()) {
    throw new Error('OAuth client ID is not configured')
  }
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error('OAuth PKCE requires Web Crypto support')
  }
  if (authorizationInFlight) {
    throw new OAuthRedirectStartedError()
  }

  authorizationInFlight = true
  const state = randomBase64Url(OAUTH.STATE_BYTES)
  const codeVerifier = randomBase64Url(OAUTH.CODE_VERIFIER_BYTES)
  const codeChallenge = await createCodeChallenge(codeVerifier)
  const redirectUri = getRedirectUri()

  writeSession(AUTH_OAUTH_PENDING_STATE, state)
  writeSession(AUTH_OAUTH_PENDING_CODE_VERIFIER, codeVerifier)
  writeSession(AUTH_OAUTH_PENDING_REDIRECT_URI, redirectUri)
  writeSession(AUTH_OAUTH_PENDING_RETURN_TO, safeReturnPath(returnTo))

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH.CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH.SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  window.location.assign(`${OAUTH.AUTHORIZE_URL}?${params.toString()}`)
  throw new OAuthRedirectStartedError()
}

export function isOAuthTokenFlowEnabled(): boolean {
  return isConfigured()
}

export function hasOAuthRefreshToken(): boolean {
  return readLocal(AUTH_OAUTH_REFRESH_TOKEN) !== null
}

export async function getOAuthAccessToken(
  returnTo?: string,
): Promise<string | null> {
  if (!isConfigured()) return null

  const storedAccessToken = readStoredAccessToken()
  if (storedAccessToken) return storedAccessToken

  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      refreshInFlight = null
    })
  }
  const refreshedToken = await refreshInFlight
  if (refreshedToken) return refreshedToken

  return startAuthorization(returnTo)
}

export async function completeOAuthAuthorization(
  currentUrl: string,
): Promise<string> {
  const url = new URL(currentUrl)
  const expectedState = readSession(AUTH_OAUTH_PENDING_STATE)
  const returnedState = url.searchParams.get('state')
  const returnTo = safeReturnPath(readSession(AUTH_OAUTH_PENDING_RETURN_TO))

  if (!expectedState || !returnedState || expectedState !== returnedState) {
    clearPendingAuthorization()
    throw new Error('Invalid OAuth state')
  }

  const error = url.searchParams.get('error')
  if (error) {
    clearPendingAuthorization()
    throw new Error(error)
  }

  const code = url.searchParams.get('code')
  const codeVerifier = readSession(AUTH_OAUTH_PENDING_CODE_VERIFIER)
  const redirectUri = readSession(AUTH_OAUTH_PENDING_REDIRECT_URI)
  if (!code || !codeVerifier || !redirectUri) {
    clearPendingAuthorization()
    throw new Error('OAuth callback is missing required parameters')
  }

  const params = createTokenRequestParams('authorization_code')
  params.set('code', code)
  params.set('code_verifier', codeVerifier)
  params.set('redirect_uri', redirectUri)

  await requestToken(params)
  clearPendingAuthorization()
  return returnTo
}

export function clearOAuthAccessTokenCache(): void {
  cachedAccessToken = null
  removeSession(AUTH_OAUTH_ACCESS_TOKEN)
  removeSession(AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_AT)
}

export function clearOAuthTokens(): void {
  clearOAuthAccessTokenCache()
  removeLocal(AUTH_OAUTH_REFRESH_TOKEN)
  clearPendingAuthorization()
}

export async function revokeAndClearOAuthTokens(): Promise<void> {
  const refreshToken = readLocal(AUTH_OAUTH_REFRESH_TOKEN)
  const accessToken =
    cachedAccessToken?.token ?? readSession(AUTH_OAUTH_ACCESS_TOKEN)
  const token = refreshToken ?? accessToken

  try {
    if (token && isConfigured()) {
      const params = new URLSearchParams({
        client_id: OAUTH.CLIENT_ID,
        token,
      })
      const response = await fetch(OAUTH.REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      })
      if (!response.ok) {
        throw new Error(`OAuth revoke failed with ${response.status}`)
      }
    }
  } finally {
    clearOAuthTokens()
  }
}
