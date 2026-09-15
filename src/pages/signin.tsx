'use client'

import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { getClerkErrorMessage } from '@/utils/clerk-errors'
import { logError } from '@/utils/error-handling'
import { sanitizeRelativeRedirect } from '@/utils/redirect-url'
import { useAuth, useClerk, useSignIn, useSignUp } from '@clerk/nextjs'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useRef, useState } from 'react'
import { FaApple } from 'react-icons/fa'
import { FcGoogle } from 'react-icons/fc'
import { PiSpinner } from 'react-icons/pi'

const POST_AUTH_REDIRECT_URL = '/'
const SSO_CALLBACK_URL = '/sso-callback'
const SUPPORTED_MISSING_FIELDS = new Set([
  'first_name',
  'last_name',
  'legal_accepted',
])
const AUTH_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const UNSUPPORTED_REQUIREMENTS_MESSAGE =
  'Your account needs additional setup. Please contact support.'

type AuthMode = 'signin' | 'signup'
type AuthStep = 'email' | 'code' | 'details' | 'reset-email' | 'reset-password'
type VerificationKind =
  'primary' | 'signup' | 'mfa' | 'totp' | 'backup' | 'reset'
type PendingAction =
  | 'google'
  | 'apple'
  | 'email'
  | 'verify'
  | 'resend'
  | 'details'
  | 'reset'
  | null
type ActiveAuthAction = Exclude<PendingAction, null>

type SignInFinalizeParams = NonNullable<
  Parameters<ReturnType<typeof useSignIn>['signIn']['finalize']>[0]
>
type FinalizeNavigateParams = Parameters<
  NonNullable<SignInFinalizeParams['navigate']>
>[0]

type SignInPageProps = {
  initialMode?: AuthMode
}

export default function SignInPage({
  initialMode = 'signin',
}: SignInPageProps) {
  const router = useRouter()
  const clerk = useClerk()
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth()
  const { signIn, errors: signInErrors } = useSignIn()
  const { signUp, errors: signUpErrors } = useSignUp()
  const mode = initialMode
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [step, setStep] = useState<AuthStep>('email')
  const [verificationKind, setVerificationKind] =
    useState<VerificationKind>('primary')
  const [emailAddress, setEmailAddress] = useState('')
  const [code, setCode] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [emailMfaAvailable, setEmailMfaAvailable] = useState(false)
  const [backupCodeAvailable, setBackupCodeAvailable] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    const update = () => setIsDarkMode(root.classList.contains('dark'))
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // Optional relative return path (e.g. /signin?redirect_url=/some/page) so
  // entry points like the subscribe prompt can send users back where they
  // were after authenticating.
  const postAuthRedirectUrl =
    sanitizeRelativeRedirect(router.query.redirect_url) ??
    POST_AUTH_REDIRECT_URL

  useEffect(() => {
    if (!router.isReady || !isAuthLoaded || !isSignedIn) return
    void router.replace(postAuthRedirectUrl)
  }, [isAuthLoaded, isSignedIn, postAuthRedirectUrl, router])

  const navigateAfterAuth = async ({
    session,
    decorateUrl,
  }: FinalizeNavigateParams) => {
    if (session?.currentTask) {
      setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
      return
    }

    const url = decorateUrl(postAuthRedirectUrl)
    if (url.startsWith('http')) {
      window.location.href = url
      return
    }

    await router.push(url)
  }

  const finalizeSignIn = async () => {
    const { error } = await signIn.finalize({ navigate: navigateAfterAuth })
    if (error) {
      setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
    }
  }

  const finalizeSignUp = async () => {
    const { error } = await signUp.finalize({ navigate: navigateAfterAuth })
    if (error) {
      setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
    }
  }

  const showAdditionalRequirements = async () => {
    const missingFields = signUp.missingFields
    if (missingFields.some((field) => !SUPPORTED_MISSING_FIELDS.has(field))) {
      setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
      return
    }

    if (
      missingFields.length === 1 &&
      missingFields.includes('legal_accepted')
    ) {
      const { error } = await signUp.update({ legalAccepted: true })
      if (error) {
        setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
        return
      }
      if (signUp.status === 'complete') {
        await finalizeSignUp()
        return
      }
    }

    setStep('details')
  }

  const continueSignIn = async () => {
    if (signIn.status === 'complete') {
      await finalizeSignIn()
      return
    }

    if (
      signIn.status === 'needs_second_factor' ||
      signIn.status === 'needs_client_trust'
    ) {
      const hasTotp = signIn.supportedSecondFactors.some(
        (factor) => factor.strategy === 'totp',
      )
      const hasEmailCode = signIn.supportedSecondFactors.some(
        (factor) => factor.strategy === 'email_code',
      )
      const hasBackupCode = signIn.supportedSecondFactors.some(
        (factor) => factor.strategy === 'backup_code',
      )

      // Prefer the authenticator app when enrolled; it needs no send step.
      if (hasTotp) {
        setCode('')
        setEmailMfaAvailable(hasEmailCode)
        setBackupCodeAvailable(hasBackupCode)
        setVerificationKind('totp')
        setStep('code')
        return
      }

      if (!hasEmailCode && !hasBackupCode) {
        setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
        return
      }

      if (!hasEmailCode) {
        setCode('')
        setBackupCodeAvailable(false)
        setVerificationKind('backup')
        setStep('code')
        return
      }

      const { error } = await signIn.mfa.sendEmailCode()
      if (error) {
        setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
        return
      }

      setCode('')
      setBackupCodeAvailable(hasBackupCode)
      setVerificationKind('mfa')
      setStep('code')
      return
    }

    setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
  }

  const runAuthAction = async (
    pending: ActiveAuthAction,
    logMessage: string,
    action: string,
    operation: () => Promise<void>,
  ) => {
    setPendingAction(pending)
    setErrorMessage(null)

    try {
      await operation()
    } catch (error) {
      logError(logMessage, error, {
        component: 'SignInPage',
        action,
      })
      setErrorMessage(AUTH_ERROR_MESSAGE)
    } finally {
      setPendingAction(null)
    }
  }

  const handleSocialSignIn = async (
    strategy: 'oauth_google' | 'oauth_apple',
  ) => {
    const provider = strategy === 'oauth_google' ? 'google' : 'apple'
    await runAuthAction(
      provider,
      'Could not start social sign-in',
      'handleSocialSignIn',
      async () => {
        // Carry the return path on the callback URL so resumed flows (MFA,
        // sign-up details) can restore it when they land back on /signin.
        const redirectCallbackUrl =
          postAuthRedirectUrl === POST_AUTH_REDIRECT_URL
            ? SSO_CALLBACK_URL
            : `${SSO_CALLBACK_URL}?redirect_url=${encodeURIComponent(postAuthRedirectUrl)}`
        const { error } = await (mode === 'signup' ? signUp : signIn).sso({
          strategy,
          redirectCallbackUrl,
          redirectUrl: postAuthRedirectUrl,
        })
        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
        }
      },
    )
  }

  const handleEmailSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runAuthAction(
      'email',
      mode === 'signup' ? 'Could not create account' : 'Could not sign in',
      'handleEmailSubmit',
      async () => {
        if (mode === 'signup') {
          const { error } = await signUp.password({
            emailAddress,
            password,
            firstName: firstName || undefined,
            lastName: lastName || undefined,
          })
          if (error) {
            setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
            return
          }

          if (signUp.status === 'complete') {
            await finalizeSignUp()
            return
          }

          if (signUp.unverifiedFields.includes('email_address')) {
            const { error: sendError } =
              await signUp.verifications.sendEmailCode()
            if (sendError) {
              setErrorMessage(
                getClerkErrorMessage(sendError, AUTH_ERROR_MESSAGE),
              )
              return
            }
            setVerificationKind('signup')
            setCode('')
            setStep('code')
            return
          }

          if (signUp.status === 'missing_requirements') {
            await showAdditionalRequirements()
            return
          }

          setErrorMessage(AUTH_ERROR_MESSAGE)
          return
        }

        const { error } = await signIn.password({
          identifier: emailAddress,
          password,
        })
        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
          return
        }

        await continueSignIn()
      },
    )
  }

  const verifyCode = () => {
    switch (verificationKind) {
      case 'signup':
        return signUp.verifications.verifyEmailCode({ code })
      case 'reset':
        return signIn.resetPasswordEmailCode.verifyCode({ code })
      case 'primary':
        return signIn.emailCode.verifyCode({ code })
      case 'mfa':
        return signIn.mfa.verifyEmailCode({ code })
      case 'backup':
        return signIn.mfa.verifyBackupCode({ code })
      case 'totp':
        return signIn.mfa.verifyTOTP({ code })
    }
  }

  const resendCode = () => {
    switch (verificationKind) {
      case 'signup':
        return signUp.verifications.sendEmailCode()
      case 'reset':
        return signIn.resetPasswordEmailCode.sendCode()
      case 'primary':
        return signIn.emailCode.sendCode()
      case 'mfa':
        return signIn.mfa.sendEmailCode()
      case 'backup':
      case 'totp':
        throw new Error('This verification strategy does not send codes')
    }
  }

  const handleCodeSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runAuthAction(
      'verify',
      'Could not verify sign-in code',
      'handleCodeSubmit',
      async () => {
        const { error } = await verifyCode()

        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
          return
        }

        if (verificationKind === 'signup') {
          if (signUp.status === 'complete') {
            await finalizeSignUp()
          } else if (signUp.status === 'missing_requirements') {
            await showAdditionalRequirements()
          } else {
            setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
          }
          return
        }

        if (verificationKind === 'reset') {
          if (signIn.status === 'needs_new_password') {
            setCode('')
            setStep('reset-password')
          } else {
            setErrorMessage(AUTH_ERROR_MESSAGE)
          }
          return
        }

        await continueSignIn()
      },
    )
  }

  const handleResendCode = async () => {
    await runAuthAction(
      'resend',
      'Could not resend sign-in code',
      'handleResendCode',
      async () => {
        const { error } = await resendCode()
        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
        }
      },
    )
  }

  const handleUseEmailMfa = async () => {
    await runAuthAction(
      'resend',
      'Could not send sign-in code',
      'handleUseEmailMfa',
      async () => {
        const { error } = await signIn.mfa.sendEmailCode()
        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
          return
        }
        setCode('')
        setVerificationKind('mfa')
      },
    )
  }

  const handleUseBackupCode = () => {
    setErrorMessage(null)
    setCode('')
    setVerificationKind('backup')
  }

  const handleDetailsSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runAuthAction(
      'details',
      'Could not complete sign-up',
      'handleDetailsSubmit',
      async () => {
        const { error } = await signUp.update({
          firstName: signUp.missingFields.includes('first_name')
            ? firstName
            : undefined,
          lastName: signUp.missingFields.includes('last_name')
            ? lastName
            : undefined,
          legalAccepted: signUp.missingFields.includes('legal_accepted')
            ? true
            : undefined,
        })
        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
          return
        }

        if (signUp.status === 'complete') {
          await finalizeSignUp()
          return
        }

        setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
      },
    )
  }

  const handleResetEmailSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runAuthAction(
      'reset',
      'Could not send password reset code',
      'handleResetEmailSubmit',
      async () => {
        const { error: createError } = await signIn.create({
          identifier: emailAddress,
        })
        if (createError) {
          setErrorMessage(getClerkErrorMessage(createError, AUTH_ERROR_MESSAGE))
          return
        }

        const { error: sendError } =
          await signIn.resetPasswordEmailCode.sendCode()
        if (sendError) {
          setErrorMessage(getClerkErrorMessage(sendError, AUTH_ERROR_MESSAGE))
          return
        }

        setCode('')
        setVerificationKind('reset')
        setStep('code')
      },
    )
  }

  const handleNewPasswordSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runAuthAction(
      'reset',
      'Could not reset password',
      'handleNewPasswordSubmit',
      async () => {
        const { error } = await signIn.resetPasswordEmailCode.submitPassword({
          password: newPassword,
          signOutOfOtherSessions: true,
        })
        if (error) {
          setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
          return
        }

        await continueSignIn()
      },
    )
  }

  const landingAttemptCheckedRef = useRef(false)
  useEffect(() => {
    if (!router.isReady || !clerk.loaded || landingAttemptCheckedRef.current) {
      return
    }

    landingAttemptCheckedRef.current = true
    if (router.query.resume === '1') return

    if (mode === 'signup' && signUp.id) {
      void signUp.reset()
    } else if (mode === 'signin' && signIn.id) {
      void signIn.reset()
    }
  }, [
    clerk.loaded,
    mode,
    router.isReady,
    router.query.resume,
    signIn,
    signIn.id,
    signUp,
    signUp.id,
  ])

  // Social sign-ins that still need MFA, client trust, or sign-up details
  // come back from the SSO callback with ?resume=1 — pick the flow back up
  // instead of dropping the user on the blank email form.
  const resumeAttemptedRef = useRef(false)
  useEffect(() => {
    if (!router.isReady || router.query.resume !== '1') return
    if (resumeAttemptedRef.current) return

    if (
      signIn.status === 'needs_second_factor' ||
      signIn.status === 'needs_client_trust'
    ) {
      resumeAttemptedRef.current = true
      if (signIn.identifier) {
        setEmailAddress(signIn.identifier)
      }
      void runAuthAction(
        'verify',
        'Could not resume social sign-in',
        'resumeSsoSignIn',
        continueSignIn,
      )
      return
    }

    if (signIn.status === 'needs_first_factor') {
      resumeAttemptedRef.current = true
      const hasEmailCode = signIn.supportedFirstFactors.some(
        (factor) => factor.strategy === 'email_code',
      )
      if (!hasEmailCode) {
        setErrorMessage(UNSUPPORTED_REQUIREMENTS_MESSAGE)
        return
      }
      if (signIn.identifier) {
        setEmailAddress(signIn.identifier)
      }
      void runAuthAction(
        'email',
        'Could not resume social sign-in',
        'resumeSsoFirstFactor',
        async () => {
          const { error } = await signIn.emailCode.sendCode()
          if (error) {
            setErrorMessage(getClerkErrorMessage(error, AUTH_ERROR_MESSAGE))
            return
          }
          setVerificationKind('primary')
          setStep('code')
        },
      )
      return
    }

    if (signUp.status === 'missing_requirements') {
      resumeAttemptedRef.current = true
      void runAuthAction(
        'details',
        'Could not resume social sign-up',
        'resumeSsoSignUp',
        showAdditionalRequirements,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.resume, signIn, signUp])

  const startOver = () => {
    signIn.reset()
    signUp.reset()
    setCode('')
    setPassword('')
    setNewPassword('')
    setErrorMessage(null)
    setVerificationKind('primary')
    setEmailMfaAvailable(false)
    setBackupCodeAvailable(false)
    setStep('email')
  }

  const isPending = pendingAction !== null

  if (!isAuthLoaded || isSignedIn) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface-chat-background font-aeonik">
        <PiSpinner className="h-6 w-6 animate-spin text-content-secondary" />
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-chat-background px-6 py-16 font-aeonik">
      <section className="w-full max-w-sm font-aeonik">
        <Link
          href="/"
          aria-label="Back to chat"
          className="mx-auto mb-10 block w-fit transition-opacity hover:opacity-70"
        >
          <Logo dark={isDarkMode} className="h-9 w-auto" />
        </Link>

        <div className="mb-8">
          <h1 className="text-2xl font-medium leading-tight text-content-primary">
            {step === 'email'
              ? mode === 'signup'
                ? 'Create your account'
                : 'Welcome back'
              : step === 'details'
                ? 'Complete your account'
                : step === 'reset-email'
                  ? 'Reset your password'
                  : step === 'reset-password'
                    ? 'Choose a new password'
                    : verificationKind === 'backup'
                      ? 'Use a recovery code'
                      : verificationKind === 'totp'
                        ? 'Two-step verification'
                        : verificationKind === 'signup'
                          ? 'Verify your email'
                          : 'Check your email'}
          </h1>
          <p className="mt-1 text-lg leading-tight text-content-muted">
            {step === 'email'
              ? mode === 'signup'
                ? 'Sign up with Google, Apple, or email'
                : 'Sign in with Google, Apple, or email'
              : step === 'details'
                ? 'Your email is verified'
                : step === 'reset-email'
                  ? 'Enter the email address for your account'
                  : step === 'reset-password'
                    ? 'Use a strong password you do not use elsewhere'
                    : verificationKind === 'backup'
                      ? 'Enter one of your saved recovery codes'
                      : verificationKind === 'totp'
                        ? 'Enter the code from your authenticator app'
                        : `We sent a verification code to ${emailAddress}`}
          </p>
        </div>

        {step === 'email' && (
          <>
            <div className="space-y-3">
              <Button
                type="button"
                variant="landingOutline"
                size="landing"
                disabled={isPending}
                onClick={() => handleSocialSignIn('oauth_google')}
                className="w-full"
              >
                {pendingAction === 'google' ? (
                  <PiSpinner className="h-4 w-4 animate-spin" />
                ) : (
                  <FcGoogle className="h-4 w-4" />
                )}
                Continue with Google
              </Button>
              <Button
                type="button"
                variant="landingOutline"
                size="landing"
                disabled={isPending}
                onClick={() => handleSocialSignIn('oauth_apple')}
                className="w-full"
              >
                {pendingAction === 'apple' ? (
                  <PiSpinner className="h-4 w-4 animate-spin" />
                ) : (
                  <FaApple className="h-4 w-4" />
                )}
                Continue with Apple
              </Button>
            </div>

            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-border-subtle" />
              <span className="text-xs text-content-muted">or</span>
              <div className="h-px flex-1 bg-border-subtle" />
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-5">
              {mode === 'signup' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="first-name"
                      className="mb-2 block text-sm text-content-secondary"
                    >
                      First name
                    </label>
                    <input
                      id="first-name"
                      name="firstName"
                      type="text"
                      autoComplete="given-name"
                      required
                      value={firstName}
                      onChange={(event) => setFirstName(event.target.value)}
                      className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors focus:border-border-strong"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="last-name"
                      className="mb-2 block text-sm text-content-secondary"
                    >
                      Last name
                    </label>
                    <input
                      id="last-name"
                      name="lastName"
                      type="text"
                      autoComplete="family-name"
                      required
                      value={lastName}
                      onChange={(event) => setLastName(event.target.value)}
                      className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors focus:border-border-strong"
                    />
                  </div>
                </div>
              )}
              <div>
                <label
                  htmlFor="email"
                  className="mb-2 block text-sm text-content-secondary"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={emailAddress}
                  onChange={(event) => setEmailAddress(event.target.value)}
                  placeholder="you@example.com"
                  aria-describedby={
                    errorMessage || signInErrors.fields.identifier
                      ? 'auth-error'
                      : undefined
                  }
                  className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-border-strong"
                />
              </div>
              <div>
                <label
                  htmlFor="password"
                  className="mb-2 block text-sm text-content-secondary"
                >
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === 'signup' ? 'new-password' : 'current-password'
                  }
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors focus:border-border-strong"
                />
              </div>
              <Button
                type="submit"
                variant="solid"
                size="landing"
                chevron
                disabled={isPending}
                className="w-full"
              >
                {pendingAction === 'email' && (
                  <PiSpinner className="h-4 w-4 animate-spin" />
                )}
                {mode === 'signup' ? 'Create account' : 'Sign in'}
              </Button>
              {mode === 'signin' && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    setErrorMessage(null)
                    setStep('reset-email')
                  }}
                  className="mx-auto block text-sm text-content-secondary underline transition-colors hover:text-content-primary disabled:opacity-60"
                >
                  Forgot password?
                </button>
              )}
            </form>
            <p className="mt-6 text-center text-sm text-content-secondary">
              {mode === 'signup' ? 'Already signed up? ' : 'New to Tinfoil? '}
              <Link
                href={
                  mode === 'signup'
                    ? `/signin?redirect_url=${encodeURIComponent(postAuthRedirectUrl)}`
                    : `/signup?redirect_url=${encodeURIComponent(postAuthRedirectUrl)}`
                }
                className="underline hover:text-content-primary"
              >
                {mode === 'signup' ? 'Log in' : 'Create account'}
              </Link>
            </p>
          </>
        )}

        {step === 'code' && (
          <form onSubmit={handleCodeSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="code"
                className="mb-2 block text-sm text-content-secondary"
              >
                {verificationKind === 'backup'
                  ? 'Recovery code'
                  : 'Verification code'}
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode={
                  verificationKind === 'backup' ? undefined : 'numeric'
                }
                autoComplete="one-time-code"
                required
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-describedby={
                  errorMessage || signInErrors.fields.code
                    ? 'auth-error'
                    : undefined
                }
                className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm tracking-[0.25em] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-border-strong"
              />
            </div>
            <Button
              type="submit"
              variant="solid"
              size="landing"
              chevron
              disabled={isPending}
              className="w-full"
            >
              {pendingAction === 'verify' && (
                <PiSpinner className="h-4 w-4 animate-spin" />
              )}
              Verify
            </Button>
            <div className="flex flex-wrap justify-center gap-4 text-sm">
              {verificationKind !== 'totp' && verificationKind !== 'backup' ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleResendCode}
                  className="text-content-secondary transition-colors hover:text-content-primary disabled:opacity-60"
                >
                  {pendingAction === 'resend' ? 'Sending...' : 'Resend code'}
                </button>
              ) : (
                emailMfaAvailable && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={handleUseEmailMfa}
                    className="text-content-secondary transition-colors hover:text-content-primary disabled:opacity-60"
                  >
                    {pendingAction === 'resend'
                      ? 'Sending...'
                      : 'Email me a code instead'}
                  </button>
                )
              )}
              {backupCodeAvailable && verificationKind !== 'backup' && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleUseBackupCode}
                  className="text-content-secondary transition-colors hover:text-content-primary disabled:opacity-60"
                >
                  Use a recovery code
                </button>
              )}
              <button
                type="button"
                disabled={isPending}
                onClick={startOver}
                className="text-content-secondary transition-colors hover:text-content-primary disabled:opacity-60"
              >
                Use another email
              </button>
            </div>
          </form>
        )}

        {step === 'reset-email' && (
          <form onSubmit={handleResetEmailSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="reset-email"
                className="mb-2 block text-sm text-content-secondary"
              >
                Email
              </label>
              <input
                id="reset-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={emailAddress}
                onChange={(event) => setEmailAddress(event.target.value)}
                className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-border-strong"
              />
            </div>
            <Button
              type="submit"
              variant="solid"
              size="landing"
              chevron
              disabled={isPending}
              className="w-full"
            >
              {pendingAction === 'reset' && (
                <PiSpinner className="h-4 w-4 animate-spin" />
              )}
              Send reset code
            </Button>
            <button
              type="button"
              disabled={isPending}
              onClick={startOver}
              className="mx-auto block text-sm text-content-secondary transition-colors hover:text-content-primary disabled:opacity-60"
            >
              Back to log in
            </button>
          </form>
        )}

        {step === 'reset-password' && (
          <form onSubmit={handleNewPasswordSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="new-password"
                className="mb-2 block text-sm text-content-secondary"
              >
                New password
              </label>
              <input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                autoFocus
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors focus:border-border-strong"
              />
            </div>
            <Button
              type="submit"
              variant="solid"
              size="landing"
              chevron
              disabled={isPending}
              className="w-full"
            >
              {pendingAction === 'reset' && (
                <PiSpinner className="h-4 w-4 animate-spin" />
              )}
              Reset password
            </Button>
          </form>
        )}

        {step === 'details' && (
          <form onSubmit={handleDetailsSubmit} className="space-y-5">
            {signUp.missingFields.includes('first_name') && (
              <div>
                <label
                  htmlFor="first-name"
                  className="mb-2 block text-sm text-content-secondary"
                >
                  First name
                </label>
                <input
                  id="first-name"
                  name="firstName"
                  type="text"
                  autoComplete="given-name"
                  required
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors focus:border-border-strong"
                />
              </div>
            )}
            {signUp.missingFields.includes('last_name') && (
              <div>
                <label
                  htmlFor="last-name"
                  className="mb-2 block text-sm text-content-secondary"
                >
                  Last name
                </label>
                <input
                  id="last-name"
                  name="lastName"
                  type="text"
                  autoComplete="family-name"
                  required
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="h-11 w-full rounded-lg border border-border-subtle bg-surface-chat px-3 text-sm text-content-primary outline-none transition-colors focus:border-border-strong"
                />
              </div>
            )}
            <Button
              type="submit"
              variant="solid"
              size="landing"
              chevron
              disabled={isPending}
              className="w-full"
            >
              {pendingAction === 'details' && (
                <PiSpinner className="h-4 w-4 animate-spin" />
              )}
              Create account
            </Button>
          </form>
        )}

        {(errorMessage ||
          signInErrors.fields.identifier ||
          signInErrors.fields.code ||
          signUpErrors.fields.emailAddress ||
          signUpErrors.fields.password) && (
          <p
            id="auth-error"
            role="alert"
            className="mx-auto mt-4 w-full break-words rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm leading-relaxed text-red-500"
          >
            {errorMessage ||
              signInErrors.fields.identifier?.longMessage ||
              signInErrors.fields.code?.longMessage ||
              signUpErrors.fields.emailAddress?.longMessage ||
              signUpErrors.fields.password?.longMessage}
          </p>
        )}

        <p className="mt-8 text-balance text-center text-xs leading-relaxed text-content-muted">
          By continuing, you agree to our{' '}
          <a
            href="https://tinfoil.sh/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors hover:text-content-primary"
          >
            Terms
          </a>{' '}
          and acknowledge our{' '}
          <a
            href="https://tinfoil.sh/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors hover:text-content-primary"
          >
            Privacy Policy
          </a>
          .
        </p>

        <div id="clerk-captcha" />
      </section>
    </main>
  )
}
