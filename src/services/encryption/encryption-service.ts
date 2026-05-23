// Encryption service for end-to-end encryption of chat data

import {
  LEGACY_ENCRYPTION_KEY,
  LEGACY_ENCRYPTION_KEY_HISTORY,
  USER_ENCRYPTION_KEY,
  USER_ENCRYPTION_KEY_HISTORY,
} from '@/constants/storage-keys'
import {
  base64ToUint8Array,
  compressAndEncrypt,
  decryptAndDecompress,
  uint8ArrayToBase64,
} from '@/utils/binary-codec'
import { logInfo } from '@/utils/error-handling'

export interface EncryptedData {
  iv: string // Base64 encoded initialization vector
  data: string // Base64 encoded encrypted data
}

export type FallbackKeyAddedCallback = () => void

/**
 * Custom event fired whenever the primary chat encryption key changes
 * (set, cleared, or replaced). Consumers that derive material from the
 * chat KEK (e.g. `useExecSnapshot`, the projects refresh in
 * `use-projects.ts`) listen for this to react without polling.
 */
export const ENCRYPTION_KEY_CHANGED_EVENT = 'encryptionKeyChanged'

function dispatchEncryptionKeyChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ENCRYPTION_KEY_CHANGED_EVENT))
  }
}

export class EncryptionService {
  private encryptionKey: CryptoKey | null = null
  private currentKeyString: string | null = null
  private fallbackKeyStrings: string[] = []
  private fallbackKeyCache: Map<string, CryptoKey> = new Map()
  private fallbackKeyAddedCallbacks: Set<FallbackKeyAddedCallback> = new Set()
  private initPromise: Promise<unknown> | null = null

  // Helper to convert bytes to alphanumeric string (a-z, 0-9)
  // Always produces even-length strings (2 characters per byte)
  private bytesToAlphanumeric(bytes: Uint8Array): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''

    for (let i = 0; i < bytes.length; i++) {
      // Convert each byte to base36 (0-9, a-z)
      const byte = bytes[i]
      result += chars[Math.floor(byte / chars.length)]
      result += chars[byte % chars.length]
    }

    return result
  }

  // Helper to convert alphanumeric string back to bytes
  private alphanumericToBytes(str: string): Uint8Array {
    // Validate input length is even (required for proper decoding)
    if (str.length % 2 !== 0) {
      throw new Error('Key length must be even')
    }

    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const bytes = new Uint8Array(str.length / 2)

    for (let i = 0; i < str.length; i += 2) {
      const high = chars.indexOf(str[i])
      const low = chars.indexOf(str[i + 1])

      if (high === -1 || low === -1) {
        throw new Error('Invalid character in key')
      }

      const value = high * chars.length + low
      if (value > 255) {
        throw new Error('Invalid character pair in key')
      }
      bytes[i / 2] = value
    }

    return bytes
  }

  private getKeyBytes(keyString: string): Uint8Array {
    if (!keyString.startsWith('key_')) {
      throw new Error('Key must start with "key_" prefix')
    }

    const processedKey = keyString.substring(4)

    if (!/^[a-z0-9]+$/.test(processedKey)) {
      throw new Error(
        'Key must only contain lowercase letters and numbers after the prefix',
      )
    }

    return this.alphanumericToBytes(processedKey)
  }

  private async importCryptoKey(keyString: string): Promise<CryptoKey> {
    const keyData = this.getKeyBytes(keyString)

    return await crypto.subtle.importKey(
      'raw',
      keyData.buffer.slice(
        keyData.byteOffset,
        keyData.byteOffset + keyData.byteLength,
      ) as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  private loadKeyHistoryFromStorage(): string[] {
    const rawHistory =
      localStorage.getItem(USER_ENCRYPTION_KEY_HISTORY) ??
      localStorage.getItem(LEGACY_ENCRYPTION_KEY_HISTORY)

    if (!rawHistory) {
      return []
    }

    try {
      const parsed = JSON.parse(rawHistory)
      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed.filter(
        (value: unknown): value is string =>
          typeof value === 'string' && value.startsWith('key_'),
      )
    } catch (error) {
      logInfo('Failed to parse encryption key history', {
        component: 'EncryptionService',
        action: 'loadKeyHistory',
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return []
    }
  }

  private saveKeyHistoryToStorage(history: string[]): void {
    localStorage.setItem(USER_ENCRYPTION_KEY_HISTORY, JSON.stringify(history))
  }

  private pruneFallbackCache(validKeys: string[]): void {
    for (const key of Array.from(this.fallbackKeyCache.keys())) {
      if (!validKeys.includes(key)) {
        this.fallbackKeyCache.delete(key)
      }
    }
  }

  private async getFallbackCryptoKey(
    keyString: string,
  ): Promise<CryptoKey | null> {
    const cached = this.fallbackKeyCache.get(keyString)
    if (cached) {
      return cached
    }

    try {
      const cryptoKey = await this.importCryptoKey(keyString)
      this.fallbackKeyCache.set(keyString, cryptoKey)
      return cryptoKey
    } catch (error) {
      logInfo('Failed to import fallback encryption key', {
        component: 'EncryptionService',
        action: 'getFallbackCryptoKey',
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  // Generate a new encryption key
  async generateKey(): Promise<string> {
    const key = await crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256,
      },
      true, // extractable
      ['encrypt', 'decrypt'],
    )

    // Export key to raw format
    const rawKey = await crypto.subtle.exportKey('raw', key)

    // Convert to alphanumeric format with key_ prefix
    return 'key_' + this.bytesToAlphanumeric(new Uint8Array(rawKey))
  }

  // Initialize with existing key - does NOT generate a new key automatically
  async initialize(): Promise<string | null> {
    const storedKey =
      localStorage.getItem(USER_ENCRYPTION_KEY) ??
      localStorage.getItem(LEGACY_ENCRYPTION_KEY)
    this.fallbackKeyStrings = this.loadKeyHistoryFromStorage()
    this.pruneFallbackCache(this.fallbackKeyStrings)

    if (storedKey) {
      await this.setKey(storedKey)
      return storedKey
    }

    return null
  }

  // Set encryption key from alphanumeric string
  async setKey(keyString: string): Promise<void> {
    try {
      const previousKey =
        this.currentKeyString ??
        localStorage.getItem(USER_ENCRYPTION_KEY) ??
        localStorage.getItem(LEGACY_ENCRYPTION_KEY)

      const previousHistory = this.loadKeyHistoryFromStorage()

      // Import as CryptoKey - ensure we have a proper ArrayBuffer
      const importedKey = await this.importCryptoKey(keyString)

      // Prepare new history (excluding the key we are setting)
      let history = previousHistory.filter(
        (storedKey) => storedKey !== keyString,
      )

      if (previousKey && previousKey !== keyString) {
        history = [
          previousKey,
          ...history.filter((storedKey) => storedKey !== previousKey),
        ]
      }

      this.persistKeyState(
        {
          primaryKey: keyString,
          history,
          includeLegacyKey: false,
        },
        {
          previousKey,
          previousHistory,
          includeLegacyKey: false,
        },
        {
          failurePrefix: 'Failed to persist encryption key',
          rollbackAction: 'setKeyRollback',
        },
      )

      this.encryptionKey = importedKey
      this.currentKeyString = keyString
      this.fallbackKeyStrings = history
      this.fallbackKeyCache.delete(keyString)
      this.pruneFallbackCache(history)
      dispatchEncryptionKeyChanged()
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Failed to persist encryption key')
      ) {
        throw error
      }
      throw new Error(`Invalid encryption key: ${error}`)
    }
  }

  // Get current encryption key as alphanumeric string
  getKey(): string | null {
    return (
      localStorage.getItem(USER_ENCRYPTION_KEY) ??
      localStorage.getItem(LEGACY_ENCRYPTION_KEY)
    )
  }

  // Get current encryption key as raw bytes, or null if no key is set.
  // Used as HKDF input keying material for derived keys (e.g. code execution).
  getCurrentKeyBytes(): Uint8Array | null {
    const keyString = this.getKey()
    if (!keyString) return null
    try {
      return this.getKeyBytes(keyString)
    } catch {
      return null
    }
  }

  /**
   * Return the raw CEK bytes for the current key, decoded from the
   * `key_<base36>` storage shape. Throws when no key is set or the
   * stored value fails format validation. Used by the enclave wire
   * adapters that need the CEK in base64 — `getKey()` alone is the
   * user-facing key string, not the raw bytes.
   */
  getKeyBytesOrThrow(): Uint8Array {
    const key = this.getKey()
    if (!key) {
      throw new Error('encryption-service: no encryption key available')
    }
    return this.getKeyBytes(key)
  }

  /**
   * Return the raw bytes for one of the alternative (history) keys, or
   * null when the index is out of range. Same `key_<base36>` decoding
   * as `getKeyBytesOrThrow`.
   */
  getAlternativeKeyBytes(keyString: string): Uint8Array | null {
    try {
      return this.getKeyBytes(keyString)
    } catch {
      return null
    }
  }

  // Remove encryption key
  clearKey(options: { persist?: boolean } = {}): void {
    const { persist = true } = options
    this.encryptionKey = null
    this.currentKeyString = null
    this.fallbackKeyCache.clear()
    this.fallbackKeyStrings = []
    this.fallbackKeyAddedCallbacks.clear()
    if (persist) {
      try {
        localStorage.removeItem(USER_ENCRYPTION_KEY)
        localStorage.removeItem(USER_ENCRYPTION_KEY_HISTORY)
        localStorage.removeItem(LEGACY_ENCRYPTION_KEY)
        localStorage.removeItem(LEGACY_ENCRYPTION_KEY_HISTORY)
      } catch (error) {
        logInfo('Failed to remove encryption keys from storage', {
          component: 'EncryptionService',
          action: 'clearKeyPersist',
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
    dispatchEncryptionKeyChanged()
  }

  /**
   * Add a decryption key to the fallback list without changing the primary key.
   *
   * This allows users to add old keys that can be used to decrypt historical
   * chats without overwriting the current encryption key.
   *
   * @param keyString The key to add (must start with "key_" prefix)
   * @throws Error if the key format is invalid
   */
  addDecryptionKey(keyString: string): void {
    // Validate key format (throws if invalid)
    this.getKeyBytes(keyString)

    // Don't add if it's the current key
    if (keyString === this.currentKeyString) {
      logInfo('Key is already the primary encryption key', {
        component: 'EncryptionService',
        action: 'addDecryptionKey',
      })
      return
    }

    // Don't add duplicates
    if (this.fallbackKeyStrings.includes(keyString)) {
      logInfo('Key is already in fallback list', {
        component: 'EncryptionService',
        action: 'addDecryptionKey',
      })
      return
    }

    // Add to fallback list
    this.fallbackKeyStrings.push(keyString)
    this.saveKeyHistoryToStorage(this.fallbackKeyStrings)

    logInfo('Added decryption key to fallback list', {
      component: 'EncryptionService',
      action: 'addDecryptionKey',
      metadata: {
        fallbackKeyCount: this.fallbackKeyStrings.length,
      },
    })

    // Notify listeners that a new fallback key was added
    // This allows triggering retry of failed decryptions
    this.notifyFallbackKeyAdded()
  }

  /**
   * Get the count of fallback decryption keys available.
   */
  getFallbackKeyCount(): number {
    return this.fallbackKeyStrings.length
  }

  /**
   * Drop every alternative (history) key from memory and from the
   * persisted key-history bucket. Used by the Layer C cleanup once
   * the legacy-blob migration loop reports `fullyMigrated`. Safe to
   * call when there are no fallbacks — clears the cache and
   * localStorage entries without disturbing the primary CEK.
   */
  clearFallbackKeys(): void {
    if (this.fallbackKeyStrings.length === 0) {
      this.fallbackKeyCache.clear()
      this.saveKeyHistoryToStorage([])
      return
    }
    this.fallbackKeyStrings = []
    this.fallbackKeyCache.clear()
    this.saveKeyHistoryToStorage([])
  }

  /**
   * Get all keys (primary + alternatives) for external backup.
   * Used by passkey key storage to encrypt the full key bundle.
   */
  getAllKeys(): { primary: string | null; alternatives: string[] } {
    return {
      primary: this.currentKeyString,
      alternatives: [...this.fallbackKeyStrings],
    }
  }

  /**
   * Bulk-load primary + alternative keys from an external source (e.g. passkey recovery).
   * Sets the primary key and populates the fallback list, persisting both to localStorage.
   */
  async setAllKeys(primary: string, alternatives: string[]): Promise<void> {
    await this.setKey(primary)

    let addedNew = false
    for (const k of alternatives) {
      if (k === primary) continue
      try {
        this.getKeyBytes(k)
      } catch {
        // Skip keys that fail format validation (prefix, charset, length)
        continue
      }
      if (k === this.currentKeyString || this.fallbackKeyStrings.includes(k)) {
        continue
      }
      this.fallbackKeyStrings.push(k)
      addedNew = true
    }

    if (addedNew) {
      this.saveKeyHistoryToStorage(this.fallbackKeyStrings)
      this.notifyFallbackKeyAdded()
    }
  }

  async replaceKeyBundle(
    primary: string | null,
    alternatives: string[],
  ): Promise<void> {
    if (!primary) {
      this.clearKey()
      return
    }

    const importedKey = await this.importCryptoKey(primary)
    const previousKey =
      this.currentKeyString ??
      localStorage.getItem(USER_ENCRYPTION_KEY) ??
      localStorage.getItem(LEGACY_ENCRYPTION_KEY)
    const previousHistory = this.loadKeyHistoryFromStorage()

    const validAlternatives = Array.from(
      new Set(
        alternatives.filter((candidate) => {
          if (candidate === primary) return false
          try {
            this.getKeyBytes(candidate)
            return true
          } catch {
            return false
          }
        }),
      ),
    )

    this.persistKeyState(
      {
        primaryKey: primary,
        history: validAlternatives,
        includeLegacyKey: true,
      },
      {
        previousKey,
        previousHistory,
        includeLegacyKey: true,
      },
      {
        failurePrefix: 'Failed to persist encryption key bundle',
        rollbackAction: 'replaceKeyBundleRollback',
      },
    )

    this.encryptionKey = importedKey
    this.currentKeyString = primary
    this.fallbackKeyCache.clear()
    this.fallbackKeyStrings = validAlternatives
    dispatchEncryptionKeyChanged()
  }

  /**
   * Register a callback to be called when a fallback key is added.
   * Returns an unsubscribe function.
   */
  onFallbackKeyAdded(callback: FallbackKeyAddedCallback): () => void {
    this.fallbackKeyAddedCallbacks.add(callback)
    return () => {
      this.fallbackKeyAddedCallbacks.delete(callback)
    }
  }

  /**
   * Notify all registered callbacks that a fallback key was added.
   */
  private notifyFallbackKeyAdded(): void {
    for (const callback of this.fallbackKeyAddedCallbacks) {
      try {
        callback()
      } catch (error) {
        logInfo('Fallback key callback error', {
          component: 'EncryptionService',
          action: 'notifyFallbackKeyAdded',
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }

  private persistKeyState(
    nextState: {
      primaryKey: string
      history: string[]
      includeLegacyKey: boolean
    },
    previousState: {
      previousKey: string | null
      previousHistory: string[]
      includeLegacyKey: boolean
    },
    options: {
      failurePrefix: string
      rollbackAction: 'setKeyRollback' | 'replaceKeyBundleRollback'
    },
  ): void {
    try {
      localStorage.setItem(USER_ENCRYPTION_KEY, nextState.primaryKey)
      if (nextState.includeLegacyKey) {
        localStorage.setItem(LEGACY_ENCRYPTION_KEY, nextState.primaryKey)
      }
      this.saveKeyHistoryToStorage(nextState.history)
    } catch (persistError) {
      try {
        if (previousState.previousKey) {
          localStorage.setItem(USER_ENCRYPTION_KEY, previousState.previousKey)
          if (previousState.includeLegacyKey) {
            localStorage.setItem(
              LEGACY_ENCRYPTION_KEY,
              previousState.previousKey,
            )
          }
        } else {
          localStorage.removeItem(USER_ENCRYPTION_KEY)
          if (previousState.includeLegacyKey) {
            localStorage.removeItem(LEGACY_ENCRYPTION_KEY)
          }
        }
        this.saveKeyHistoryToStorage(previousState.previousHistory)
      } catch (rollbackError) {
        logInfo('Failed to rollback encryption key persistence', {
          component: 'EncryptionService',
          action: options.rollbackAction,
          metadata: {
            persistError:
              persistError instanceof Error
                ? persistError.message
                : String(persistError),
            rollbackError:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          },
        })
      }

      throw new Error(
        `${options.failurePrefix}: ${
          persistError instanceof Error
            ? persistError.message
            : String(persistError)
        }`,
      )
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.encryptionKey) {
      if (!this.initPromise) {
        this.initPromise = this.initialize().finally(() => {
          this.initPromise = null
        })
      }
      await this.initPromise
    }
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized')
    }
  }

  // Encrypt data
  async encrypt(data: any): Promise<EncryptedData> {
    await this.ensureInitialized()

    // Convert data to string
    const dataString = JSON.stringify(data)

    // Encrypt the data directly
    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(dataString)

    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(12))

    // Encrypt
    const encryptedData = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      this.encryptionKey!,
      dataBytes.buffer.slice(
        dataBytes.byteOffset,
        dataBytes.byteOffset + dataBytes.byteLength,
      ) as ArrayBuffer,
    )

    // Convert to base64 safely for large data
    const ivBase64 = uint8ArrayToBase64(iv)
    const dataBase64 = uint8ArrayToBase64(new Uint8Array(encryptedData))

    return {
      iv: ivBase64,
      data: dataBase64,
    }
  }

  // Decrypt data
  async decrypt(encryptedData: EncryptedData): Promise<any> {
    const { result } = await this.decryptRaw(encryptedData)
    return result
  }

  // Decrypt data with fallback key tracking (for re-encryption decisions)
  async decryptWithFallbackInfo(
    encryptedData: EncryptedData,
  ): Promise<{ data: any; usedFallbackKey: boolean }> {
    const { result, usedFallbackKey } = await this.decryptRaw(encryptedData)
    return { data: result, usedFallbackKey }
  }

  private async decryptRaw(
    encryptedData: EncryptedData,
  ): Promise<{ result: any; usedFallbackKey: boolean }> {
    await this.ensureInitialized()

    try {
      // Validate input data
      if (!encryptedData.iv || !encryptedData.data) {
        throw new Error('Missing IV or data in encrypted data')
      }

      // Convert base64 back to bytes with validation
      let iv: Uint8Array
      let data: Uint8Array

      try {
        iv = base64ToUint8Array(encryptedData.iv)
        data = base64ToUint8Array(encryptedData.data)
      } catch (error) {
        throw new Error(`Invalid base64 encoding: ${error}`)
      }

      return await this.decryptWithFallback(
        (key) => this.decryptWithKey(key, iv, data),
        'decrypt',
      )
    } catch (error) {
      throw new Error(`Decryption failed: ${error}`)
    }
  }

  // Encrypt data using v1 binary format (gzip + AES-GCM, raw binary output)
  async encryptV1(data: unknown): Promise<Uint8Array> {
    await this.ensureInitialized()
    return compressAndEncrypt(data, this.encryptionKey!)
  }

  // Decrypt v1 binary format with fallback key support
  async decryptV1(binary: Uint8Array): Promise<unknown> {
    const { result } = await this.decryptV1Raw(binary)
    return result
  }

  // Decrypt v1 binary format with fallback key tracking (for re-encryption decisions)
  async decryptV1WithFallbackInfo(
    binary: Uint8Array,
  ): Promise<{ data: unknown; usedFallbackKey: boolean }> {
    const { result, usedFallbackKey } = await this.decryptV1Raw(binary)
    return { data: result, usedFallbackKey }
  }

  private async decryptV1Raw(
    binary: Uint8Array,
  ): Promise<{ result: unknown; usedFallbackKey: boolean }> {
    await this.ensureInitialized()
    try {
      return await this.decryptWithFallback(
        (key) => decryptAndDecompress(binary, key),
        'decryptV1',
      )
    } catch (error) {
      throw new Error(`Decryption failed: ${error}`)
    }
  }

  private async decryptWithFallback<T>(
    decryptFn: (key: CryptoKey) => Promise<T>,
    action: string,
  ): Promise<{ result: T; usedFallbackKey: boolean }> {
    try {
      const result = await decryptFn(this.encryptionKey!)
      return { result, usedFallbackKey: false }
    } catch (primaryError) {
      let lastError: unknown = primaryError

      for (const [index, keyString] of this.fallbackKeyStrings.entries()) {
        const fallbackKey = await this.getFallbackCryptoKey(keyString)
        if (!fallbackKey) {
          continue
        }

        try {
          const result = await decryptFn(fallbackKey)
          logInfo('Decryption succeeded with fallback key', {
            component: 'EncryptionService',
            action,
            metadata: { fallbackIndex: index },
          })
          return { result, usedFallbackKey: true }
        } catch (fallbackError) {
          lastError = fallbackError
        }
      }

      if (lastError instanceof Error) {
        throw lastError
      }

      throw new Error(String(lastError ?? 'No valid encryption keys'))
    }
  }

  private async decryptWithKey(
    cryptoKey: CryptoKey,
    iv: Uint8Array,
    data: Uint8Array,
  ): Promise<any> {
    const decryptedData = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer.slice(
          iv.byteOffset,
          iv.byteOffset + iv.byteLength,
        ) as ArrayBuffer,
      },
      cryptoKey,
      data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer,
    )

    return await this.parseDecryptedPayload(decryptedData)
  }

  private async parseDecryptedPayload(
    decryptedData: ArrayBuffer,
  ): Promise<any> {
    const decoder = new TextDecoder()
    const decryptedString = decoder.decode(decryptedData)

    if (decryptedString.startsWith('H4sI')) {
      const { isGzippedData, safeDecompress } = await import(
        '@/utils/compression'
      )

      if (isGzippedData(decryptedString)) {
        logInfo('Decompressing gzipped data', {
          component: 'EncryptionService',
          action: 'decrypt',
          metadata: { dataLength: decryptedString.length },
        })

        const decompressedString = safeDecompress(decryptedString)

        if (!decompressedString) {
          throw new Error(
            'DATA_CORRUPTED: Failed to decompress data - may be corrupted or malformed',
          )
        }

        return JSON.parse(decompressedString)
      }
    }

    return JSON.parse(decryptedString)
  }
}

export const encryptionService = new EncryptionService()
