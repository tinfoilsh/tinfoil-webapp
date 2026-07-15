import { AuthenticateWithRedirectCallback } from '@clerk/nextjs'

const SIGNIN_RESUME_URL = '/signin?resume=1'

export default function SsoCallbackPage() {
  return (
    <AuthenticateWithRedirectCallback
      secondFactorUrl={SIGNIN_RESUME_URL}
      firstFactorUrl={SIGNIN_RESUME_URL}
      continueSignUpUrl={SIGNIN_RESUME_URL}
    />
  )
}
