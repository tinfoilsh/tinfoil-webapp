import { verificationDocument as readVerificationDocument } from '@/services/harness/attestation'
import { logError } from '@/utils/error-handling'
import { TfBoxX } from '@tinfoilsh/tinfoil-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CONSTANTS } from './chat/constants'

const VERIFICATION_CENTER_BASE_URL = 'https://verification-center.tinfoil.sh'
const VERIFICATION_CENTER_ORIGIN = new URL(VERIFICATION_CENTER_BASE_URL).origin

type VerifierSidebarProps = {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  onVerificationComplete: (success: boolean) => void
  isDarkMode: boolean
  isClient: boolean
}

export function VerifierSidebar({
  isOpen,
  setIsOpen,
  onVerificationComplete,
  isDarkMode,
  isClient,
}: VerifierSidebarProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isReady, setIsReady] = useState(false)
  const [verificationDocument, setVerificationDocument] = useState<any>(null)

  // Keep the latest callback in a ref so `fetchVerificationDocument` can stay
  // referentially stable. The parent passes it as an inline function, so
  // depending on it directly would recreate the callback every render and
  // re-fire the effects that trigger verification — an unbounded fetch loop.
  const onVerificationCompleteRef = useRef(onVerificationComplete)
  onVerificationCompleteRef.current = onVerificationComplete

  const isFetchingRef = useRef(false)
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // A failed verification, as from a dropped connection, is retried with
  // backoff before it is reported.
  const fetchVerificationDocument = useCallback(async () => {
    if (isFetchingRef.current) return
    isFetchingRef.current = true
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const doc = await readVerificationDocument()
          if (!isMountedRef.current) return
          setVerificationDocument(doc)
          onVerificationCompleteRef.current(true)
          return
        } catch (cause) {
          if (!isMountedRef.current) return
          logError('Unable to verify chat service', cause, {
            component: 'VerifierSidebar',
            metadata: { attempt: attempt + 1 },
          })
          if (attempt >= CONSTANTS.VERIFICATION_MAX_RETRIES) {
            onVerificationCompleteRef.current(false)
            return
          }
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            CONSTANTS.VERIFICATION_RETRY_DELAY_MS *
              CONSTANTS.VERIFICATION_RETRY_BACKOFF_FACTOR ** attempt,
          ),
        )
        if (!isMountedRef.current) return
      }
    } finally {
      isFetchingRef.current = false
    }
  }, [])

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

  // Fetch the verification document only when the panel is open so it can be
  // posted into the iframe. The header badge status is owned by the parent
  // (ChatInterface), which fetches the same document on mount, so there is no
  // need to verify here while the panel is closed.
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
        } fixed right-0 top-0 z-40 flex h-full overflow-hidden border-l border-border-subtle bg-surface-sidebar font-aeonik transition-all duration-200 ease-in-out`}
        style={{
          width: CONSTANTS.MOBILE_SIDEBAR_WIDTH,
          maxWidth: `${CONSTANTS.VERIFIER_SIDEBAR_WIDTH_PX}px`,
        }}
      >
        {/* Keep the iframe loaded while closed so opening only changes visibility. */}
        {isClient && (
          <iframe
            ref={iframeRef}
            src={iframeUrl}
            loading="eager"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups"
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
            <TfBoxX className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
