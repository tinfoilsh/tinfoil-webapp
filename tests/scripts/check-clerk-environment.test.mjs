import { describe, expect, it, vi } from 'vitest'

import {
  checkClerkEnvironment,
  getClerkAuthDrift,
  getClerkPrivacyDrift,
} from '../../scripts/check-clerk-environment.mjs'

function environment({
  captchaEnabled = false,
  captchaProvider = null,
  passwordEnabled = true,
  passwordRequired = true,
  signUpMode = 'public',
  emailEnabled = true,
  verifyEmailAtSignUp = true,
  emailVerifications = ['email_code'],
} = {}) {
  return {
    display_config: { captcha_provider: captchaProvider },
    user_settings: {
      sign_up: { captcha_enabled: captchaEnabled, mode: signUpMode },
      attributes: {
        password: { enabled: passwordEnabled, required: passwordRequired },
        email_address: {
          enabled: emailEnabled,
          verify_at_sign_up: verifyEmailAtSignUp,
          verifications: emailVerifications,
        },
      },
    },
  }
}

describe('Clerk environment privacy check', () => {
  it('accepts disabled CAPTCHA without a provider', () => {
    expect(getClerkPrivacyDrift(environment())).toEqual([])
  })

  it('reports enabled CAPTCHA and a configured provider', () => {
    expect(
      getClerkPrivacyDrift(
        environment({ captchaEnabled: true, captchaProvider: 'turnstile' }),
      ),
    ).toEqual([
      'user_settings.sign_up.captcha_enabled must be false',
      'display_config.captcha_provider must be null',
    ])
  })

  it('fails closed when expected configuration fields are absent', () => {
    expect(getClerkPrivacyDrift({})).toHaveLength(2)
  })

  it('accepts password signup with email-code verification', () => {
    expect(getClerkAuthDrift(environment())).toEqual([])
  })

  it('reports authentication settings incompatible with the custom flow', () => {
    expect(
      getClerkAuthDrift(
        environment({
          passwordEnabled: false,
          passwordRequired: false,
          signUpMode: 'restricted',
          emailEnabled: false,
          verifyEmailAtSignUp: false,
          emailVerifications: [],
        }),
      ),
    ).toEqual([
      'user_settings.sign_up.mode must be public',
      'user_settings.attributes.password.enabled must be true',
      'user_settings.attributes.password.required must be true',
      'user_settings.attributes.email_address.enabled must be true',
      'user_settings.attributes.email_address.verify_at_sign_up must be true',
      'user_settings.attributes.email_address.verifications must include email_code',
    ])
  })

  it('fails closed when authentication configuration is absent', () => {
    expect(getClerkAuthDrift({})).toHaveLength(6)
  })

  it('checks the fetched production response', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(environment()),
    })

    await expect(
      checkClerkEnvironment({ fetchImplementation }),
    ).resolves.toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://clerk.tinfoil.sh/v1/environment',
      expect.objectContaining({
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('reports HTTP status details', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })

    await expect(
      checkClerkEnvironment({ fetchImplementation }),
    ).rejects.toThrow(
      'Clerk environment request failed with status 503 Service Unavailable',
    )
  })

  it.each([
    ['network failure', new TypeError('connection failed')],
    ['timeout', new DOMException('timed out', 'TimeoutError')],
  ])('reports a structured %s', async (_, requestError) => {
    const fetchImplementation = vi.fn().mockRejectedValue(requestError)

    await expect(
      checkClerkEnvironment({ fetchImplementation }),
    ).rejects.toMatchObject({
      message: `Clerk environment request failed: ${requestError.message}`,
      cause: requestError,
    })
  })

  it('reports an invalid JSON response', async () => {
    const parseError = new SyntaxError('Unexpected token')
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(parseError),
    })

    await expect(
      checkClerkEnvironment({ fetchImplementation }),
    ).rejects.toMatchObject({
      message:
        'Clerk environment response was not valid JSON: Unexpected token',
      cause: parseError,
    })
  })

  it('reports privacy configuration drift', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(environment({ captchaEnabled: true })),
    })

    await expect(
      checkClerkEnvironment({ fetchImplementation }),
    ).rejects.toThrow('Clerk configuration drifted')
  })
})
