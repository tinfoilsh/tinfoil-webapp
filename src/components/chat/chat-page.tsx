'use client'

import { LogoLoading } from '@/components/ui/logo-loading'
import NotFound from '@/pages/404'
import {
  isLocalNewChatStorage,
  NEW_CHAT_STORAGE_QUERY_KEY,
} from '@/utils/navigation'
import { useRouter } from 'next/router'
import { ChatRoute } from './chat-route'

// The page of the /chat/* and /project/* section shells, which the host
// serves for any path in their section.
// The static chat entry points export this same component so assigning a
// new chat's URL keeps its conversation and stream mounted.
export default function ChatPage() {
  const router = useRouter()
  // Prerendered state: the same full-screen loader the chat page showed on
  // main, so the first paint is not a bare page.
  if (!router.isReady) return <LogoLoading />

  const slug = router.query.slug
  const rest = Array.isArray(slug) ? slug : slug ? [slug] : []
  // A section's shell is its /<section>/[[...slug]] page.
  const section = router.pathname.split('/')[1]

  const newChat = router.pathname === '/newchat'
  switch (router.pathname === '/' || newChat ? 'chat' : section) {
    case 'chat': {
      const isLocal = rest[0] === 'local'
      return (
        <div className="h-screen font-aeonik">
          <ChatRoute
            projectRoute={false}
            projectId={null}
            chatId={(isLocal ? rest[1] : rest[0]) ?? null}
            isLocalChatUrl={isLocal}
            {...(newChat
              ? {
                  initialNewChatIsLocalOnly: isLocalNewChatStorage(
                    router.query[NEW_CHAT_STORAGE_QUERY_KEY],
                  ),
                  suppressIntroModals: true,
                }
              : {})}
          />
        </div>
      )
    }
    case 'project':
      return (
        <div className="h-screen font-aeonik">
          <ChatRoute
            projectId={rest[0] ?? null}
            chatId={rest[1] === 'chat' ? (rest[2] ?? null) : null}
          />
        </div>
      )
    default:
      return <NotFound />
  }
}
