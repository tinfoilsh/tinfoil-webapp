import SignInPage from '@/pages/signin'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => {
  const signIn = {
    id: undefined as string | undefined,
    status: 'needs_identifier',
    supportedSecondFactors: [] as Array<{ strategy: string }>,
    supportedFirstFactors: [] as Array<{ strategy: string }>,
    create: vi.fn(),
    password: vi.fn(),
    emailCode: {
      sendCode: vi.fn(),
      verifyCode: vi.fn(),
    },
    mfa: {
      sendEmailCode: vi.fn(),
      verifyEmailCode: vi.fn(),
      verifyTOTP: vi.fn(),
      verifyBackupCode: vi.fn(),
    },
    sso: vi.fn(),
    resetPasswordEmailCode: {
      sendCode: vi.fn(),
      verifyCode: vi.fn(),
      submitPassword: vi.fn(),
    },
    finalize: vi.fn(),
    reset: vi.fn(),
  }
  const signUp = {
    id: undefined as string | undefined,
    status: 'missing_requirements',
    missingFields: [] as string[],
    unverifiedFields: [] as string[],
    update: vi.fn(),
    password: vi.fn(),
    sso: vi.fn(),
    verifications: {
      sendEmailCode: vi.fn(),
      verifyEmailCode: vi.fn(),
    },
    finalize: vi.fn(),
    reset: vi.fn(),
  }

  const router = {
    isReady: true,
    query: {} as Record<string, string | undefined>,
  }

  return {
    clerkLoaded: true,
    isAuthLoaded: true,
    isSignedIn: false,
    signIn,
    signUp,
    router,
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    signInErrors: {} as Record<string, unknown>,
    signUpErrors: {} as Record<string, unknown>,
  }
})

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({
    isLoaded: auth.isAuthLoaded,
    isSignedIn: auth.isSignedIn,
  }),
  useClerk: () => ({ loaded: auth.clerkLoaded }),
  useSignIn: () => ({
    signIn: auth.signIn,
    errors: { fields: auth.signInErrors },
    fetchStatus: 'idle',
  }),
  useSignUp: () => ({
    signUp: auth.signUp,
    errors: { fields: auth.signUpErrors },
    fetchStatus: 'idle',
  }),
}))

vi.mock('next/router', () => ({
  useRouter: () => ({
    push: auth.routerPush,
    replace: auth.routerReplace,
    ...auth.router,
  }),
}))

function renderAndSubmitPasswordSignIn(password = 'account password') {
  render(<SignInPage />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
    target: { value: 'person@example.com' },
  })
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('SignInPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.clerkLoaded = true
    auth.isAuthLoaded = true
    auth.isSignedIn = false
    auth.router.isReady = true
    auth.router.query = {}
    auth.signIn.id = undefined
    auth.signIn.status = 'needs_identifier'
    auth.signIn.supportedSecondFactors = []
    auth.signIn.supportedFirstFactors = []
    auth.signUp.status = 'missing_requirements'
    auth.signUp.id = undefined
    auth.signUp.missingFields = []
    auth.signUp.unverifiedFields = []
    auth.signInErrors = {}
    auth.signUpErrors = {}
    auth.signIn.create.mockResolvedValue({ error: null })
    auth.signIn.password.mockResolvedValue({ error: null })
    auth.signIn.emailCode.sendCode.mockResolvedValue({ error: null })
    auth.signIn.emailCode.verifyCode.mockResolvedValue({ error: null })
    auth.signIn.mfa.sendEmailCode.mockResolvedValue({ error: null })
    auth.signIn.mfa.verifyEmailCode.mockResolvedValue({ error: null })
    auth.signIn.mfa.verifyTOTP.mockResolvedValue({ error: null })
    auth.signIn.mfa.verifyBackupCode.mockResolvedValue({ error: null })
    auth.signIn.sso.mockResolvedValue({ error: null })
    auth.signIn.resetPasswordEmailCode.sendCode.mockResolvedValue({
      error: null,
    })
    auth.signIn.resetPasswordEmailCode.verifyCode.mockResolvedValue({
      error: null,
    })
    auth.signIn.resetPasswordEmailCode.submitPassword.mockResolvedValue({
      error: null,
    })
    auth.signIn.finalize.mockResolvedValue({ error: null })
    auth.signIn.reset.mockResolvedValue({ error: null })
    auth.signUp.update.mockResolvedValue({ error: null })
    auth.signUp.password.mockResolvedValue({ error: null })
    auth.signUp.sso.mockResolvedValue({ error: null })
    auth.signUp.verifications.sendEmailCode.mockResolvedValue({ error: null })
    auth.signUp.verifications.verifyEmailCode.mockResolvedValue({ error: null })
    auth.signUp.finalize.mockResolvedValue({ error: null })
    auth.signUp.reset.mockResolvedValue({ error: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the branded layout with social and email options', () => {
    const { container } = render(<SignInPage />)

    expect(container.firstChild).toHaveClass('font-aeonik')
    expect(
      screen.queryByRole('heading', { name: 'Welcome to Tinfoil' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Private AI Chat')).not.toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: 'Tinfoil' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Back to chat' })).toHaveAttribute(
      'href',
      '/',
    )
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Continue with Apple' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument()
    expect(document.querySelector('#clerk-captcha')).toBeInTheDocument()
    expect(screen.getByText(/By continuing, you agree to our/)).toHaveClass(
      'text-balance',
      'text-center',
    )
  })

  it('redirects an already signed-in user to the requested page', async () => {
    auth.isSignedIn = true
    auth.router.query = { redirect_url: '/project/example' }

    render(<SignInPage />)

    await waitFor(() => {
      expect(auth.routerReplace).toHaveBeenCalledWith('/project/example')
    })
  })

  it('clears an abandoned sign-in attempt on a fresh landing', async () => {
    auth.signIn.id = 'stale_sign_in'

    render(<SignInPage />)

    await waitFor(() => {
      expect(auth.signIn.reset).toHaveBeenCalledTimes(1)
    })
  })

  it('preserves a sign-in attempt resumed from the OAuth callback', () => {
    auth.router.query = { resume: '1' }
    auth.signIn.id = 'resumed_sign_in'

    render(<SignInPage />)

    expect(auth.signIn.reset).not.toHaveBeenCalled()
  })

  it('does not reset a sign-in attempt started after landing', () => {
    const { rerender } = render(<SignInPage />)

    auth.signIn.id = 'new_sign_in'
    rerender(<SignInPage />)

    expect(auth.signIn.reset).not.toHaveBeenCalled()
  })

  it('clears an abandoned sign-up attempt on a fresh signup landing', async () => {
    auth.signUp.id = 'stale_sign_up'

    render(<SignInPage initialMode="signup" />)

    await waitFor(() => {
      expect(auth.signUp.reset).toHaveBeenCalledTimes(1)
    })
  })

  it('signs in an existing account with its password', async () => {
    auth.signIn.password.mockImplementation(async () => {
      auth.signIn.status = 'complete'
      return { error: null }
    })
    renderAndSubmitPasswordSignIn('correct horse battery staple')

    await waitFor(() => {
      expect(auth.signIn.password).toHaveBeenCalledWith({
        identifier: 'person@example.com',
        password: 'correct horse battery staple',
      })
      expect(auth.signIn.finalize).toHaveBeenCalledWith({
        navigate: expect.any(Function),
      })
    })
  })

  it('creates a password account and verifies its email code', async () => {
    auth.signUp.password.mockImplementation(async () => {
      auth.signUp.status = 'missing_requirements'
      auth.signUp.unverifiedFields = ['email_address']
      return { error: null }
    })
    render(<SignInPage initialMode="signup" />)

    fireEvent.change(screen.getByRole('textbox', { name: 'First name' }), {
      target: { value: 'New' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Last name' }), {
      target: { value: 'Person' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'new@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'new account password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(auth.signUp.password).toHaveBeenCalledWith({
        emailAddress: 'new@example.com',
        password: 'new account password',
        firstName: 'New',
        lastName: 'Person',
      })
      expect(auth.signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1)
    })

    expect(
      screen.getByRole('heading', { name: 'Verify your email' }),
    ).toBeInTheDocument()
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Verification code' }),
      { target: { value: '654321' } },
    )
    auth.signUp.verifications.verifyEmailCode.mockImplementation(async () => {
      auth.signUp.status = 'complete'
      auth.signUp.unverifiedFields = []
      return { error: null }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => {
      expect(auth.signUp.verifications.verifyEmailCode).toHaveBeenCalledWith({
        code: '654321',
      })
      expect(auth.signUp.finalize).toHaveBeenCalledWith({
        navigate: expect.any(Function),
      })
    })
  })

  it('verifies an authenticator app code when TOTP is the second factor', async () => {
    auth.signIn.password.mockImplementation(async () => {
      auth.signIn.status = 'needs_second_factor'
      auth.signIn.supportedSecondFactors = [{ strategy: 'totp' }]
      return { error: null }
    })
    auth.signIn.mfa.verifyTOTP.mockImplementation(async () => {
      auth.signIn.status = 'complete'
      return { error: null }
    })
    renderAndSubmitPasswordSignIn()

    expect(
      await screen.findByRole('heading', { name: 'Two-step verification' }),
    ).toBeInTheDocument()
    expect(auth.signIn.mfa.sendEmailCode).not.toHaveBeenCalled()

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Verification code' }),
      { target: { value: '987654' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => {
      expect(auth.signIn.mfa.verifyTOTP).toHaveBeenCalledWith({
        code: '987654',
      })
      expect(auth.signIn.finalize).toHaveBeenCalledWith({
        navigate: expect.any(Function),
      })
    })
  })

  it('resets a forgotten password with an email code', async () => {
    auth.signIn.resetPasswordEmailCode.verifyCode.mockImplementation(
      async () => {
        auth.signIn.status = 'needs_new_password'
        return { error: null }
      },
    )
    auth.signIn.resetPasswordEmailCode.submitPassword.mockImplementation(
      async () => {
        auth.signIn.status = 'complete'
        return { error: null }
      },
    )
    render(<SignInPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'person@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))

    await waitFor(() => {
      expect(auth.signIn.create).toHaveBeenCalledWith({
        identifier: 'person@example.com',
      })
      expect(auth.signIn.resetPasswordEmailCode.sendCode).toHaveBeenCalled()
    })

    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Verification code' }),
      { target: { value: '123456' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'replacement password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => {
      expect(
        auth.signIn.resetPasswordEmailCode.submitPassword,
      ).toHaveBeenCalledWith({
        password: 'replacement password',
        signOutOfOtherSessions: true,
      })
      expect(auth.signIn.finalize).toHaveBeenCalled()
    })
  })

  it('shows password sign-in errors in a centered alert box', async () => {
    auth.signIn.password.mockResolvedValue({
      error: { longMessage: 'The password is incorrect.' },
    })
    renderAndSubmitPasswordSignIn('incorrect password')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The password is incorrect.')
    expect(alert).toHaveClass(
      'mx-auto',
      'rounded-lg',
      'border',
      'bg-red-500/10',
      'text-center',
    )
  })

  it('shows an error returned while activating the session', async () => {
    auth.signIn.password.mockImplementation(async () => {
      auth.signIn.status = 'complete'
      return { error: null }
    })
    auth.signIn.finalize.mockResolvedValue({
      error: { longMessage: 'The session could not be activated.' },
    })
    renderAndSubmitPasswordSignIn()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The session could not be activated.',
    )
  })

  it('lets the user fall back to an email MFA code from the TOTP prompt', async () => {
    auth.signIn.password.mockImplementation(async () => {
      auth.signIn.status = 'needs_second_factor'
      auth.signIn.supportedSecondFactors = [
        { strategy: 'totp' },
        { strategy: 'email_code' },
      ]
      return { error: null }
    })
    renderAndSubmitPasswordSignIn()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Email me a code instead' }),
    )

    await waitFor(() => {
      expect(auth.signIn.mfa.sendEmailCode).toHaveBeenCalledTimes(1)
    })
    expect(
      await screen.findByRole('heading', { name: 'Check your email' }),
    ).toBeInTheDocument()

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Verification code' }),
      { target: { value: '555555' } },
    )
    auth.signIn.mfa.verifyEmailCode.mockImplementation(async () => {
      auth.signIn.status = 'complete'
      return { error: null }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => {
      expect(auth.signIn.mfa.verifyEmailCode).toHaveBeenCalledWith({
        code: '555555',
      })
      expect(auth.signIn.finalize).toHaveBeenCalled()
    })
  })

  it('lets the user authenticate with a recovery code', async () => {
    auth.signIn.password.mockImplementation(async () => {
      auth.signIn.status = 'needs_second_factor'
      auth.signIn.supportedSecondFactors = [
        { strategy: 'totp' },
        { strategy: 'backup_code' },
      ]
      return { error: null }
    })
    auth.signIn.mfa.verifyBackupCode.mockImplementation(async () => {
      auth.signIn.status = 'complete'
      return { error: null }
    })
    renderAndSubmitPasswordSignIn()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use a recovery code' }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Recovery code' }), {
      target: { value: 'recovery-code' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => {
      expect(auth.signIn.mfa.verifyBackupCode).toHaveBeenCalledWith({
        code: 'recovery-code',
      })
      expect(auth.signIn.finalize).toHaveBeenCalled()
    })
  })

  it.each([
    ['Google', 'oauth_google'],
    ['Apple', 'oauth_apple'],
  ] as const)(
    'starts %s sign-in in the current tab',
    async (provider, strategy) => {
      const openSpy = vi.spyOn(window, 'open')
      render(<SignInPage />)

      fireEvent.click(
        screen.getByRole('button', { name: `Continue with ${provider}` }),
      )

      await waitFor(() => {
        expect(openSpy).not.toHaveBeenCalled()
        expect(auth.signIn.sso).toHaveBeenCalledWith({
          strategy,
          redirectCallbackUrl: '/sso-callback',
          redirectUrl: '/',
        })
      })
    },
  )

  it('starts social sign-up from the create-account page', async () => {
    render(<SignInPage initialMode="signup" />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    )

    await waitFor(() => {
      expect(auth.signUp.sso).toHaveBeenCalledWith({
        strategy: 'oauth_google',
        redirectCallbackUrl: '/sso-callback',
        redirectUrl: '/',
      })
      expect(auth.signIn.sso).not.toHaveBeenCalled()
    })
  })

  it('shows the Clerk error when social sign-in cannot start', async () => {
    auth.signIn.sso.mockResolvedValue({
      error: { longMessage: 'Google sign-in is unavailable.' },
    })
    render(<SignInPage />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google sign-in is unavailable.',
    )
  })

  it('prefers the detailed Clerk error over its generic message', async () => {
    auth.signIn.sso.mockResolvedValue({
      error: {
        message: 'Clerk: Request failed (oauth_error)',
        errors: [{ longMessage: 'Google sign-in is temporarily unavailable.' }],
      },
    })
    render(<SignInPage />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google sign-in is temporarily unavailable.',
    )
  })
})
