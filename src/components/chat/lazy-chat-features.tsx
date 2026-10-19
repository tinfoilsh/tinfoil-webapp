import dynamic from 'next/dynamic'

// Lazy load heavy features that aren't needed immediately
export const ChatMessages = dynamic(
  () => import('./chat-messages').then((m) => m.ChatMessages),
  {
    ssr: false,
    loading: () => <div className="flex-1" />,
  },
)

export const ChatSidebar = dynamic(
  () => import('./chat-sidebar').then((m) => m.ChatSidebar),
  { ssr: false },
)

export const VerificationStatusDisplay = dynamic(
  () =>
    import('./verification-status-display').then(
      (m) => m.VerificationStatusDisplay,
    ),
  { ssr: false },
)
