import { getVerificationDocument } from '@/services/inference/tinfoil-client'
import { logError, logInfo } from '@/utils/error-handling'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CONSTANTS } from './chat/constants'

const VERIFICATION_CENTER_BASE_URL = 'https://verification-center.tinfoil.sh'
const VERIFICATION_CENTER_ORIGIN = new URL(VERIFICATION_CENTER_BASE_URL).origin

function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type VerifierSidebarProps = {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  verificationComplete: boolean
  verificationSuccess?: boolean
  onVerificationComplete: (success: boolean) => void
  onVerificationUpdate?: (state: any) => void
  isDarkMode: boolean
  isClient: boolean
}

export function VerifierSidebar({
  isOpen,
  setIsOpen,
  verificationComplete,
  verificationSuccess,
  onVerificationComplete,
  onVerificationUpdate,
  isDarkMode,
  isClient,
}: VerifierSidebarProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isReady, setIsReady] = useState(false)
  const [verificationDocument, setVerificationDocument] = useState<any>(null)
  const retryCountRef = useRef(0)
  const isRetryingRef = useRef(false)

  const fetchVerificationDocument = useCallback(async () => {
    if (isRetryingRef.current) return
    isRetryingRef.current = true
    retryCountRef.current = 0

    const attemptFetch = async (): Promise<boolean> => {
      if (!isOnline()) {
        logInfo('No internet connection, waiting to retry verification', {
          component: 'VerifierSidebar',
          action: 'fetchVerificationDocument',
          metadata: { attempt: retryCountRef.current + 1 },
        })
        return false
      }

      try {
        const doc = await getVerificationDocument()
        if (doc) {
          setVerificationDocument(doc)
          if (onVerificationUpdate) {
            onVerificationUpdate(doc)
          }
          if (doc.securityVerified !== undefined) {
            onVerificationComplete(doc.securityVerified)
            return true
          }
        }
        return false
      } catch (error) {
        logError('Failed to fetch verification document', error, {
          component: 'VerifierSidebar',
          action: 'fetchVerificationDocument',
          metadata: { attempt: retryCountRef.current + 1 },
        })
        return false
      }
    }

    let success = await attemptFetch()

    while (
      !success &&
      retryCountRef.current < CONSTANTS.VERIFICATION_MAX_RETRIES
    ) {
      retryCountRef.current++
      const backoffDelay =
        CONSTANTS.VERIFICATION_RETRY_DELAY_MS *
        Math.pow(1.5, retryCountRef.current - 1)

      logInfo('Retrying verification fetch', {
        component: 'VerifierSidebar',
        action: 'fetchVerificationDocument',
        metadata: {
          attempt: retryCountRef.current,
          maxRetries: CONSTANTS.VERIFICATION_MAX_RETRIES,
          delayMs: backoffDelay,
        },
      })

      await delay(backoffDelay)
      success = await attemptFetch()
    }

    isRetryingRef.current = false
  }, [onVerificationUpdate, onVerificationComplete])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== VERIFICATION_CENTER_ORIGIN) return
      if (event.data.type === 'TINFOIL_VERIFICATION_CENTER_READY') {
        setIsReady(true)
      } else if (event.data.type === 'TINFOIL_VERIFICATION_CENTER_CLOSED') {
        setIsOpen(false)
      } else if (event.data.type === 'TINFOIL_REQUEST_VERIFICATION_DOCUMENT') {
        fetchVerificationDocument()
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [setIsOpen, fetchVerificationDocument])

  useEffect(() => {
    if (!isReady || !verificationDocument || !iframeRef.current) return

    const send = () => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'TINFOIL_VERIFICATION_DOCUMENT',
          document: verificationDocument,
        },
        VERIFICATION_CENTER_ORIGIN,
      )
    }

    send()
    const retryDelays = [100, 300, 800, 2000]
    const timers = retryDelays.map((delay) => setTimeout(send, delay))
    return () => timers.forEach(clearTimeout)
  }, [isReady, verificationDocument])

  useEffect(() => {
    if (isOpen && isClient) {
      fetchVerificationDocument()
    }
  }, [isOpen, isClient, fetchVerificationDocument])

  useEffect(() => {
    if (isReady && iframeRef.current) {
      const message = isOpen
        ? { type: 'TINFOIL_VERIFICATION_CENTER_OPEN' }
        : { type: 'TINFOIL_VERIFICATION_CENTER_CLOSE' }
      iframeRef.current.contentWindow?.postMessage(
        message,
        VERIFICATION_CENTER_ORIGIN,
      )
    }
  }, [isOpen, isReady])

  const iframeUrl = `${VERIFICATION_CENTER_BASE_URL}?darkMode=${isDarkMode}&showVerificationFlow=true&compact=false&open=true`

  return (
    <>
      <div
        inert={!isOpen}
        className={`${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        } fixed right-0 top-0 z-40 flex h-full w-[85vw] overflow-hidden border-l border-border-subtle bg-surface-sidebar font-aeonik transition-all duration-200 ease-in-out`}
        style={{ maxWidth: `${CONSTANTS.VERIFIER_SIDEBAR_WIDTH_PX}px` }}
      >
        {isClient && (
          <iframe
            ref={iframeRef}
            src={iframeUrl}
            className="h-full w-full"
            style={{ border: 'none' }}
            title="Tinfoil Verification Center"
            onLoad={() => setIsReady(true)}
          />
        )}

        <div className="absolute right-0 top-0 flex items-center justify-end p-4">
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close verification panel"
            className="rounded-lg border border-border-subtle bg-surface-chat p-2 text-content-secondary shadow-sm transition-all duration-200 hover:bg-surface-chat/80"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
