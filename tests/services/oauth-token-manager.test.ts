import {
  AUTH_OAUTH_ACCESS_TOKEN,
  AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_AT,
  AUTH_OAUTH_PENDING_CODE_VERIFIER,
  AUTH_OAUTH_PENDING_REDIRECT_URI,
  AUTH_OAUTH_PENDING_RETURN_TO,
  AUTH_OAUTH_PENDING_STATE,
  AUTH_OAUTH_REFRESH_TOKEN,
} from '@/constants/storage-keys'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OAUTH_CONFIG = {
  CLIENT_ID: 'oauthc_webapp',
  AUTHORIZE_URL: 'https://dash.example/oauth/authorize',
  TOKEN_URL: 'https://api.example/oauth/token',
  REVOKE_URL: 'https://api.example/oauth/revoke',
  REDIRECT_URI: 'https://chat.example/oauth/callback',
  SCOPE: 'inference:chat offline_access',
  CALLBACK_PATH: '/oauth/callback',
  ACCESS_TOKEN_EXPIRY_BUFFER_MS: 60_000,
  CODE_VERIFIER_BYTES: 32,
  STATE_BYTES: 16,
}

async function loadManager() {
  vi.resetModules()
  vi.doMock('@/config', () => ({ OAUTH: OAUTH_CONFIG }))
  return import('@/services/auth/oauth-token-manager')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('oauth-token-manager', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('@/config')
  })

  it('refreshes an existing OAuth refresh token', async () => {
    localStorage.setItem(AUTH_OAUTH_REFRESH_TOKEN, 'oauthr_old')
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        access_token: 'chat_new',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'oauthr_new',
      }),
    )

    const { getOAuthAccessToken } = await loadManager()
    await expect(getOAuthAccessToken()).resolves.toBe('chat_new')

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = init?.body as URLSearchParams
    expect(fetch).toHaveBeenCalledWith(
      OAUTH_CONFIG.TOKEN_URL,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe(OAUTH_CONFIG.CLIENT_ID)
    expect(body.get('refresh_token')).toBe('oauthr_old')
    expect(localStorage.getItem(AUTH_OAUTH_REFRESH_TOKEN)).toBe('oauthr_new')
    expect(sessionStorage.getItem(AUTH_OAUTH_ACCESS_TOKEN)).toBe('chat_new')
  })

  it('exchanges an authorization callback for OAuth tokens', async () => {
    sessionStorage.setItem(AUTH_OAUTH_PENDING_STATE, 'state123')
    sessionStorage.setItem(AUTH_OAUTH_PENDING_CODE_VERIFIER, 'verifier123')
    sessionStorage.setItem(
      AUTH_OAUTH_PENDING_REDIRECT_URI,
      OAUTH_CONFIG.REDIRECT_URI,
    )
    sessionStorage.setItem(
      AUTH_OAUTH_PENDING_RETURN_TO,
      '/chat/thread?model=test#latest',
    )
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        access_token: 'chat_callback',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'oauthr_callback',
      }),
    )

    const { completeOAuthAuthorization } = await loadManager()
    const returnTo = await completeOAuthAuthorization(
      'https://chat.example/oauth/callback?code=code123&state=state123',
    )

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = init?.body as URLSearchParams
    expect(returnTo).toBe('/chat/thread?model=test#latest')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(OAUTH_CONFIG.CLIENT_ID)
    expect(body.get('code')).toBe('code123')
    expect(body.get('code_verifier')).toBe('verifier123')
    expect(body.get('redirect_uri')).toBe(OAUTH_CONFIG.REDIRECT_URI)
    expect(localStorage.getItem(AUTH_OAUTH_REFRESH_TOKEN)).toBe(
      'oauthr_callback',
    )
    expect(sessionStorage.getItem(AUTH_OAUTH_PENDING_STATE)).toBeNull()
  })

  it('rejects callbacks with mismatched state', async () => {
    sessionStorage.setItem(AUTH_OAUTH_PENDING_STATE, 'expected')

    const { completeOAuthAuthorization } = await loadManager()
    await expect(
      completeOAuthAuthorization(
        'https://chat.example/oauth/callback?code=code123&state=actual',
      ),
    ).rejects.toThrow('Invalid OAuth state')

    expect(fetch).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(AUTH_OAUTH_PENDING_STATE)).toBeNull()
  })

  it('revokes the stored OAuth refresh token before clearing tokens', async () => {
    localStorage.setItem(AUTH_OAUTH_REFRESH_TOKEN, 'oauthr_to_revoke')
    sessionStorage.setItem(AUTH_OAUTH_ACCESS_TOKEN, 'chat_to_clear')
    sessionStorage.setItem(
      AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_AT,
      String(Date.now() + 900_000),
    )
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}))

    const { revokeAndClearOAuthTokens } = await loadManager()
    await revokeAndClearOAuthTokens()

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const body = init?.body as URLSearchParams
    expect(fetch).toHaveBeenCalledWith(
      OAUTH_CONFIG.REVOKE_URL,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(body.get('client_id')).toBe(OAUTH_CONFIG.CLIENT_ID)
    expect(body.get('token')).toBe('oauthr_to_revoke')
    expect(localStorage.getItem(AUTH_OAUTH_REFRESH_TOKEN)).toBeNull()
    expect(sessionStorage.getItem(AUTH_OAUTH_ACCESS_TOKEN)).toBeNull()
  })
})
