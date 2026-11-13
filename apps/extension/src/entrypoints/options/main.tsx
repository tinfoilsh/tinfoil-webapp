import { ClerkProvider, useUser } from '@clerk/chrome-extension'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CLERK_FRONTEND_API,
  CLERK_PUBLISHABLE_KEY,
  WEB_SIGN_IN_URL,
} from '../../config'
import { SettingsPage } from '../../settings/settings-page'
import '../../ui/styles'
import { useWebSession } from '../../ui/web-session'

function SignedSettings() {
  const { isLoaded, signOut } = useWebSession()
  const { user } = useUser()
  if (!isLoaded) return <SettingsPage account="loading" />
  const email = user?.primaryEmailAddress?.emailAddress
  return (
    <SettingsPage
      account={
        user
          ? {
              user,
              name:
                [user.firstName, user.lastName].filter(Boolean).join(' ') ||
                email ||
                'User',
              email,
              signOut,
            }
          : 'signed-out'
      }
    />
  )
}

function App() {
  // The settings that need no account work before sign-in is set up.
  if (!CLERK_PUBLISHABLE_KEY || !CLERK_FRONTEND_API)
    return <SettingsPage account="unconfigured" />
  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      syncHost={CLERK_FRONTEND_API}
      signInUrl={WEB_SIGN_IN_URL}
      telemetry={{ disabled: true }}
    >
      <SignedSettings />
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
