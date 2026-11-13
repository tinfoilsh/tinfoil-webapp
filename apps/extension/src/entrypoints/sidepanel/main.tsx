import { ClerkProvider } from '@clerk/chrome-extension'
import { Button } from '@tinfoil/chat-ui/button'
import { StrictMode, useCallback, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CLERK_FRONTEND_API,
  CLERK_PUBLISHABLE_KEY,
  WEB_SIGN_IN_URL,
} from '../../config'
import { ChatPanel } from '../../panel/chat-panel'
import { Logo } from '../../ui/logo'
import { SignInSetup } from '../../ui/sign-in-setup'
import '../../ui/styles'
import { useDarkMode } from '../../ui/theme'
import { useWebSession } from '../../ui/web-session'
import { sessionToken } from '../../web-session'

// What the panel shows in place of the chat: opening, signing in, or setup.
function Notice({
  isDarkMode,
  children,
}: {
  isDarkMode: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-chat-background px-8 py-10 text-center text-content-primary">
      <Logo className="h-8 w-auto" dark={isDarkMode} />
      {children}
    </div>
  )
}

function SignedInApp({ isDarkMode }: { isDarkMode: boolean }) {
  const { isLoaded, userId, clerk, signInError } = useWebSession()
  const getToken = useCallback(
    (options?: { skipCache?: boolean }) => sessionToken(clerk, userId, options),
    [clerk, userId],
  )
  if (!isLoaded)
    return (
      <Notice isDarkMode={isDarkMode}>
        <p role="status" className="text-sm text-content-secondary">
          Opening Tinfoil…
        </p>
      </Notice>
    )
  if (!userId)
    return (
      <Notice isDarkMode={isDarkMode}>
        <p className="text-balance text-sm leading-relaxed text-content-secondary">
          Sign in on Tinfoil’s website. This panel will update automatically.
        </p>
        <Button asChild variant="solid">
          <a href={WEB_SIGN_IN_URL} target="_blank" rel="noopener noreferrer">
            Sign in to Tinfoil
          </a>
        </Button>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Refresh sign-in
        </Button>
        {signInError && (
          <p role="alert" className="text-sm text-destructive">
            Could not refresh sign-in. Please try again.
          </p>
        )}
      </Notice>
    )
  return (
    <ChatPanel
      key={userId}
      owner={userId}
      getToken={getToken}
      isDarkMode={isDarkMode}
    />
  )
}

function App() {
  const isDarkMode = useDarkMode()
  if (!CLERK_PUBLISHABLE_KEY || !CLERK_FRONTEND_API)
    return (
      <Notice isDarkMode={isDarkMode}>
        <p className="text-sm leading-relaxed text-content-secondary [overflow-wrap:anywhere]">
          <SignInSetup />
        </p>
        <p className="text-sm text-content-secondary">
          The development commands are in DEVELOPMENT.md.
        </p>
      </Notice>
    )
  const url = chrome.runtime.getURL('sidepanel.html')
  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      syncHost={CLERK_FRONTEND_API}
      signInUrl={WEB_SIGN_IN_URL}
      telemetry={{ disabled: true }}
      afterSignOutUrl={url}
    >
      <SignedInApp isDarkMode={isDarkMode} />
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
