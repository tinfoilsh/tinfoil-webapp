'use client'

import { ChatInterface } from '@/components/chat'
import { ProjectProvider } from '@/components/project'
import { PremiumProjectRoute } from '@/components/project/premium-project-route'
import SharePage from '@/components/share/share-page'
import { useRouter } from 'next/router'
import NotFound from './404'

// The single exported shell for every dynamic route (/chat/*, /project/*,
// /share/*). The host rewrites all unknown paths to this one file, so there
// is exactly one fallback document, which is what WEBCAT's default_fallback
// requires.
export default function CatchAllPage() {
  const router = useRouter()
  if (!router.isReady) return <div className="h-screen font-aeonik" />

  const slug = router.query.slug
  const [section, ...rest] = Array.isArray(slug) ? slug : slug ? [slug] : []

  switch (section) {
    case 'chat': {
      const isLocal = rest[0] === 'local'
      return (
        <div className="h-screen font-aeonik">
          <ProjectProvider>
            <ChatInterface
              initialChatId={(isLocal ? rest[1] : rest[0]) ?? null}
              isLocalChatUrl={isLocal}
            />
          </ProjectProvider>
        </div>
      )
    }
    case 'project':
      return (
        <div className="h-screen font-aeonik">
          <PremiumProjectRoute
            projectId={rest[0] ?? null}
            chatId={rest[1] === 'chat' ? (rest[2] ?? null) : null}
          />
        </div>
      )
    case 'share':
      return <SharePage chatId={rest[0]} />
    default:
      return <NotFound />
  }
}
