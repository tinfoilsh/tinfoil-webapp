/**
 * Code-execution key material derived from the chat encryption key (chat KEK).
 *
 * - `useExecSnapshot`: hook returning the per-user encryption key (string).
 * - `getCodeExecutionContainerAuthTokenForChat`: per-chat container auth
 *   token, memoized in a module-level cache cleared on key change.
 *
 * Using the chat KEK as IKM means code-exec access follows the chats:
 * any device that has the chat KEK (manual entry, passkey recovery,
 * cloud sync) can derive these keys.
 */
import {
  ENCRYPTION_KEY_CHANGED_EVENT,
  encryptionService,
} from '@/services/encryption/encryption-service'
import {
  deriveCodeExecutionContainerAuthToken,
  deriveCodeExecutionEncryptionKey,
} from '@/services/exec-snapshot/key-derivation'
import { uint8ArrayToBase64Url } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { useEffect, useState } from 'react'

export interface ExecSnapshotState {
  /** AES-256 key (base64url, no padding) sent on `code_execution_options.encryptionKey`. */
  codeExecutionEncryptionKey: string | null
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Cleared whenever the chat KEK changes (listener wired below). Chat IDs
// are unique enough that we don't need eviction within a session.
const codeExecutionContainerAuthTokenCache = new Map<string, string>()

function clearCodeExecutionContainerAuthTokenCache(): void {
  codeExecutionContainerAuthTokenCache.clear()
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    ENCRYPTION_KEY_CHANGED_EVENT,
    clearCodeExecutionContainerAuthTokenCache,
  )
}

function getCodeExecIkm(): Uint8Array | null {
  return encryptionService.getCurrentKeyBytes()
}

/**
 * Per-chat container auth token as hex. Returns `null` when no derivation
 * source is available (no chat KEK and not in dev). Memoized.
 */
export async function getCodeExecutionContainerAuthTokenForChat(
  chatId: string,
): Promise<string | null> {
  const cached = codeExecutionContainerAuthTokenCache.get(chatId)
  if (cached !== undefined) return cached

  const ikm = getCodeExecIkm()
  if (!ikm) return null

  const derived = await deriveCodeExecutionContainerAuthToken(ikm, chatId)
  const hex = hexEncode(derived)
  codeExecutionContainerAuthTokenCache.set(chatId, hex)
  return hex
}

export function useExecSnapshot(
  opts: { enabled: boolean } = { enabled: true },
): ExecSnapshotState {
  const { enabled } = opts
  const [codeExecutionEncryptionKey, setCodeExecutionEncryptionKey] = useState<
    string | null
  >(null)

  useEffect(() => {
    // Feature off → stay a no-op. No derivation, no listener, no key
    // ever held in component state.
    if (!enabled) {
      setCodeExecutionEncryptionKey(null)
      return
    }

    let cancelled = false
    const tryDerive = (): void => {
      if (cancelled) return
      const ikm = getCodeExecIkm()
      if (!ikm) {
        setCodeExecutionEncryptionKey(null)
        return
      }
      deriveCodeExecutionEncryptionKey(ikm)
        .then((key) => {
          if (!cancelled)
            setCodeExecutionEncryptionKey(uint8ArrayToBase64Url(key))
        })
        .catch((error) => {
          logError('Failed to derive code execution encryption key', error, {
            component: 'useExecSnapshot',
          })
          if (!cancelled) setCodeExecutionEncryptionKey(null)
        })
    }

    tryDerive()
    window.addEventListener(ENCRYPTION_KEY_CHANGED_EVENT, tryDerive)
    return () => {
      cancelled = true
      window.removeEventListener(ENCRYPTION_KEY_CHANGED_EVENT, tryDerive)
    }
  }, [enabled])

  return { codeExecutionEncryptionKey }
}
