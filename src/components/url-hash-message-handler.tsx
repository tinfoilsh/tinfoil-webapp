import { base64ToUint8Array } from '@/utils/binary-codec'
import { logError, logInfo, logWarning } from '@/utils/error-handling'
import {
  MESSAGE_HASH_PREFIX,
  MESSAGE_QUERY_PARAM,
  stripMessageMarkers,
} from '@/utils/redirect-url'
import { useRouter, type NextRouter } from 'next/router'
import { useEffect, useRef } from 'react'

interface UrlHashMessageHandlerProps {
  onMessageReady: (message: string) => void
  isReady: boolean
}

const MAX_MESSAGE_LENGTH = 50000
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * Rewrites the current URL to remove any markers that would cause the message
 * handler to re-fire on a future reload. Strips both `?q=` and `#send=` so a
 * URL like `/?q=foo#send=<b64>` can't auto-send the leftover query param later.
 * Goes through the Next router (not raw history.replaceState) so router.asPath
 * is updated too; anything that later reads asPath, such as sign-in redirect
 * links, must not see the message text.
 */
function clearMessageMarkersFromUrl(router: NextRouter) {
  const newUrl = stripMessageMarkers(
    window.location.pathname + window.location.search + window.location.hash,
  )
  router.replace(newUrl, undefined, { shallow: true }).catch(() => {
    // A rejected navigation must not leave message text in the address bar.
    window.history.replaceState(null, '', newUrl)
  })
}

function sanitizeMessage(decodedMessage: string): string | null {
  if (!decodedMessage) {
    return null
  }

  if (decodedMessage.length > MAX_MESSAGE_LENGTH) {
    logWarning('URL message exceeds maximum length', {
      component: 'UrlHashMessageHandler',
      metadata: {
        messageLength: decodedMessage.length,
        maxLength: MAX_MESSAGE_LENGTH,
      },
    })
    return null
  }

  if (CONTROL_CHARS_REGEX.test(decodedMessage)) {
    logWarning('URL message contains invalid control characters', {
      component: 'UrlHashMessageHandler',
    })
    return null
  }

  // Normalize smart quotes to regular quotes for better compatibility
  return decodedMessage
    .replace(/[\u201C\u201D]/g, '"') // Replace " and "
    .replace(/[\u2018\u2019]/g, "'") // Replace ' and '
}

/**
 * Handles two URL formats for prefilling a message:
 * 1. URL fragment: #send=<base64-encoded-message> (e.g., #send=V2hhdCBpcyAyKzI/)
 * 2. Query string: ?q=<url-encoded-message> (e.g., ?q=hello+world)
 *
 * The hash format distinguishes message sending from other fragment uses
 * like #settings/<tab>. The query format mirrors the convention used by
 * other chat tools (e.g., ChatGPT's ?q=).
 */
export function UrlHashMessageHandler({
  onMessageReady,
  isReady,
}: UrlHashMessageHandlerProps) {
  const router = useRouter()
  const hasProcessed = useRef(false)

  useEffect(() => {
    if (!isReady || hasProcessed.current) {
      return
    }

    const processHashMessage = () => {
      try {
        const hash = window.location.hash

        if (
          !hash ||
          hash.length <= 1 ||
          !hash.startsWith(MESSAGE_HASH_PREFIX)
        ) {
          return false
        }

        const encodedMessage = hash.slice(MESSAGE_HASH_PREFIX.length)

        try {
          // Decode base64 to binary, then interpret as UTF-8
          const bytes = base64ToUint8Array(encodedMessage)
          const decodedMessage = new TextDecoder('utf-8').decode(bytes)

          const normalizedMessage = sanitizeMessage(decodedMessage)
          if (!normalizedMessage) {
            return false
          }

          logInfo('Processing message from URL hash', {
            component: 'UrlHashMessageHandler',
            metadata: { messageLength: normalizedMessage.length },
          })

          hasProcessed.current = true
          onMessageReady(normalizedMessage)

          clearMessageMarkersFromUrl(router)
          return true
        } catch (decodeError) {
          logWarning('Invalid base64 encoding in URL hash', {
            component: 'UrlHashMessageHandler',
            metadata: {
              error:
                decodeError instanceof Error
                  ? decodeError.message
                  : 'Unknown error',
            },
          })
          return false
        }
      } catch (error) {
        logError('Failed to process URL hash message', error, {
          component: 'UrlHashMessageHandler',
        })
        return false
      }
    }

    const processQueryMessage = () => {
      try {
        const params = new URLSearchParams(window.location.search)
        const rawMessage = params.get(MESSAGE_QUERY_PARAM)

        if (!rawMessage) {
          return false
        }

        const normalizedMessage = sanitizeMessage(rawMessage)
        if (!normalizedMessage) {
          return false
        }

        logInfo('Processing message from URL query', {
          component: 'UrlHashMessageHandler',
          metadata: { messageLength: normalizedMessage.length },
        })

        hasProcessed.current = true
        onMessageReady(normalizedMessage)

        clearMessageMarkersFromUrl(router)
        return true
      } catch (error) {
        logError('Failed to process URL query message', error, {
          component: 'UrlHashMessageHandler',
        })
        return false
      }
    }

    if (!processHashMessage()) {
      processQueryMessage()
    }
  }, [isReady, onMessageReady, router])

  return null
}
