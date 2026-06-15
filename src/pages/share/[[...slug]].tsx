'use client'

import { initializeRenderers } from '@/components/chat/renderers/client'
import { SharedChatView } from '@/components/chat/shared-chat-view'
import { getAIModels, type BaseModel } from '@/config/models'
import { fetchSharedChat } from '@/services/share-api'
import { shareOpen as enclaveShareOpen } from '@/services/sync-enclave/sync-api'
import { decryptAndDecompress } from '@/utils/binary-codec'
import {
  validateShareableChatData,
  type ShareableChatData,
} from '@/utils/compression'
import { decryptShare, importKeyFromBase64url } from '@/utils/share-encryption'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'

const SHARE_PREVIEW_TITLE = 'Shared Chat \u2022 Tinfoil'
const SHARE_PREVIEW_DESCRIPTION =
  'Open this link to view a privately shared AI conversation on Tinfoil.'

type LoadingState = 'loading' | 'error' | 'success'

export default function SharePage() {
  const router = useRouter()
  const [loadingState, setLoadingState] = useState<LoadingState>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [chatData, setChatData] = useState<ShareableChatData | null>(null)
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [model, setModel] = useState<BaseModel | null>(null)

  useEffect(() => {
    initializeRenderers()
  }, [])

  useEffect(() => {
    const checkDarkMode = () => {
      // Check the data-theme attribute which is the source of truth
      const dataTheme = document.documentElement.getAttribute('data-theme')
      setIsDarkMode(dataTheme === 'dark')
    }

    checkDarkMode()

    // Listen for theme changes
    const handleThemeChange = () => checkDarkMode()
    window.addEventListener('themeChanged', handleThemeChange)

    // Also observe the data-theme attribute for changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'data-theme') {
          checkDarkMode()
        }
      })
    })
    observer.observe(document.documentElement, { attributes: true })

    return () => {
      window.removeEventListener('themeChanged', handleThemeChange)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!router.isReady) return

    const loadData = async () => {
      const slug = router.query.slug
      const parts =
        typeof slug === 'string' ? [slug] : Array.isArray(slug) ? slug : []
      const chatId = parts[0]

      if (!chatId) {
        setErrorMessage('No chat ID provided')
        setLoadingState('error')
        return
      }

      const rawHash = window.location.hash.slice(1)
      if (!rawHash) {
        setErrorMessage('Missing decryption key')
        setLoadingState('error')
        return
      }

      const isV2Share = rawHash.startsWith('v2:')
      const keyBase64url = isV2Share ? '' : rawHash
      const shareKeyHex = isV2Share ? rawHash.slice(3) : ''

      try {
        const fetched = await fetchSharedChat(chatId)
        let decrypted: object | null
        if (isV2Share) {
          // v2 shares are sealed by the sync enclave and opened by it
          // again here. The binary fetched from controlplane is the
          // [IV || AES-GCM ciphertext] envelope the enclave produced.
          if (fetched.formatVersion !== 1) {
            setErrorMessage('Share link / payload format mismatch')
            setLoadingState('error')
            return
          }
          const plaintext = await enclaveShareOpen({
            shareKeyHex,
            ciphertext: new Uint8Array(fetched.binary),
          })
          try {
            decrypted = JSON.parse(
              new TextDecoder().decode(plaintext),
            ) as object
          } catch {
            decrypted = null
          }
        } else if (fetched.formatVersion === 1) {
          const key = await importKeyFromBase64url(keyBase64url)
          decrypted = (await decryptAndDecompress(
            new Uint8Array(fetched.binary),
            key,
          )) as object | null
        } else {
          decrypted = await decryptShare(fetched.data, keyBase64url)
        }

        if (!decrypted) {
          setErrorMessage('Failed to decrypt chat data')
          setLoadingState('error')
          return
        }

        const parsed = validateShareableChatData(decrypted)
        if (!parsed) {
          setErrorMessage('Invalid chat data format')
          setLoadingState('error')
          return
        }

        const models = await getAIModels()
        const chatModel = models.find((m) => m.type === 'chat') || models[0]
        if (!chatModel) {
          setErrorMessage('Failed to load model configuration')
          setLoadingState('error')
          return
        }

        setChatData(parsed)
        setModel(chatModel)
        setLoadingState('success')
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Shared chat not found'
        ) {
          setErrorMessage('This shared chat does not exist or has been deleted')
        } else {
          setErrorMessage('Failed to load shared chat')
        }
        setLoadingState('error')
      }
    }

    loadData()
  }, [router.isReady, router.query.slug])

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  const sharePreviewHead = (
    <Head>
      <title key="page-title">{SHARE_PREVIEW_TITLE}</title>
      <meta
        key="description"
        name="description"
        content={SHARE_PREVIEW_DESCRIPTION}
      />
      <meta key="og:title" property="og:title" content={SHARE_PREVIEW_TITLE} />
      <meta
        key="og:description"
        property="og:description"
        content={SHARE_PREVIEW_DESCRIPTION}
      />
      <meta key="og:type" property="og:type" content="article" />
      <meta
        key="twitter:title"
        name="twitter:title"
        content={SHARE_PREVIEW_TITLE}
      />
      <meta
        key="twitter:description"
        name="twitter:description"
        content={SHARE_PREVIEW_DESCRIPTION}
      />
    </Head>
  )

  if (loadingState === 'loading') {
    return (
      <>
        {sharePreviewHead}
        <div
          className={`flex min-h-screen items-center justify-center font-aeonik ${isDarkMode ? 'bg-surface-chat-background' : 'bg-white'}`}
        >
          <div className="text-content-secondary">Loading shared chat...</div>
        </div>
      </>
    )
  }

  if (loadingState === 'error' || !chatData || !model) {
    return (
      <>
        {sharePreviewHead}
        <div
          className={`flex min-h-screen items-center justify-center font-aeonik ${isDarkMode ? 'bg-surface-chat-background' : 'bg-white'}`}
        >
          <div className="text-center">
            <h1 className="text-2xl font-bold text-content-primary">
              Invalid Share Link
            </h1>
            <p className="mt-2 text-content-secondary">
              {errorMessage ||
                'This share link is invalid or has been corrupted.'}
            </p>
            <Link
              href="/"
              className="mt-4 inline-block rounded-lg bg-button-send-background px-4 py-2 text-button-send-foreground transition-opacity hover:opacity-90"
            >
              Start a new chat
            </Link>
          </div>
        </div>
      </>
    )
  }

  const successHead = (
    <Head>
      <title key="page-title">{`${chatData.title} \u2022 Tinfoil`}</title>
      <meta
        key="description"
        name="description"
        content={SHARE_PREVIEW_DESCRIPTION}
      />
      <meta key="og:title" property="og:title" content={SHARE_PREVIEW_TITLE} />
      <meta
        key="og:description"
        property="og:description"
        content={SHARE_PREVIEW_DESCRIPTION}
      />
      <meta key="og:type" property="og:type" content="article" />
      <meta
        key="twitter:title"
        name="twitter:title"
        content={SHARE_PREVIEW_TITLE}
      />
      <meta
        key="twitter:description"
        name="twitter:description"
        content={SHARE_PREVIEW_DESCRIPTION}
      />
    </Head>
  )

  return (
    <div
      className={`flex min-h-screen flex-col font-aeonik ${isDarkMode ? 'bg-surface-chat-background' : 'bg-white'}`}
    >
      {successHead}
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm text-content-secondary">
                <span>Shared Chat</span>
                <span className="mx-2">&middot;</span>
                <span>{formatDate(chatData.createdAt)}</span>
              </div>
              <h1 className="mt-1 text-xl font-semibold text-content-primary">
                {chatData.title}
              </h1>
            </div>
            <Link
              href="/"
              className="w-fit rounded-lg bg-brand-accent-dark px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Start your own chat
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <SharedChatView
          chatData={chatData}
          isDarkMode={isDarkMode}
          model={model}
        />
      </main>

      <footer className="border-t border-border-subtle px-6 py-4">
        <div className="mx-auto max-w-3xl text-center text-sm text-content-secondary">
          <span>Powered by </span>
          <Link href="/" className="text-brand-accent-dark hover:underline">
            Tinfoil Chat
          </Link>
        </div>
      </footer>
    </div>
  )
}
