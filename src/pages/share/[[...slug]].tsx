'use client'

import SharePage from '@/components/share/share-page'
import { LogoLoading } from '@/components/ui/logo-loading'
import { useRouter } from 'next/router'

export default function ShareCatchAllPage() {
  const router = useRouter()
  // Same as the chat shell: wait for the share id before opening the link.
  if (!router.isReady) return <LogoLoading />

  const slug = router.query.slug
  const parts =
    typeof slug === 'string' ? [slug] : Array.isArray(slug) ? slug : []

  return <SharePage chatId={parts[0]} />
}
