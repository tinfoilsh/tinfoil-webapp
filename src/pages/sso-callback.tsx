import { AuthenticateWithRedirectCallback } from '@clerk/nextjs'

export default function SsoCallbackPage() {
  return <AuthenticateWithRedirectCallback />
}
