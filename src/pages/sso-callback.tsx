import { sanitizeRelativeRedirect } from '@/utils/redirect-url'
import { AuthenticateWithRedirectCallback } from '@clerk/nextjs'
import { useRouter } from 'next/router'

const SIGNIN_RESUME_URL = '/signin?resume=1'

export default function SsoCallbackPage() {
  const router = useRouter()

  // Wait for the query string so a redirect_url carried on the callback
  // survives into the resumed sign-in flow.
  if (!router.isReady) return null

  const redirectUrl = sanitizeRelativeRedirect(router.query.redirect_url)
  const resumeUrl = redirectUrl
    ? `${SIGNIN_RESUME_URL}&redirect_url=${encodeURIComponent(redirectUrl)}`
    : SIGNIN_RESUME_URL

  return (
    <AuthenticateWithRedirectCallback
      secondFactorUrl={resumeUrl}
      firstFactorUrl={resumeUrl}
      continueSignUpUrl={resumeUrl}
    />
  )
}
