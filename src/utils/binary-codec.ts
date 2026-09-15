const AES_GCM = 'AES-GCM'
const IV_LENGTH = 12
const AES_GCM_TAG_LENGTH = 16
const AES_256_KEY_LENGTH = 32

export type EncryptedAttachmentValidationErrorCode =
  'ciphertext_too_short' | 'invalid_key_length'

export class EncryptedAttachmentValidationError extends Error {
  constructor(public readonly code: EncryptedAttachmentValidationErrorCode) {
    super('Encrypted attachment structure is invalid')
    this.name = 'EncryptedAttachmentValidationError'
  }
}

/** Get a safe ArrayBuffer copy from a Uint8Array subview. */
function toBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer
}

/** Concatenate IV(12) || ciphertext into a single Uint8Array. */
function packIvCiphertext(iv: Uint8Array, ciphertext: ArrayBuffer): Uint8Array {
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), IV_LENGTH)
  return result
}

/** Split IV(12) || ciphertext, validating minimum length. */
function unpackIvCiphertext(data: Uint8Array): {
  iv: Uint8Array
  ciphertext: Uint8Array
} {
  if (data.length < IV_LENGTH + AES_GCM_TAG_LENGTH) {
    throw new EncryptedAttachmentValidationError('ciphertext_too_short')
  }
  return {
    iv: data.subarray(0, IV_LENGTH),
    ciphertext: data.subarray(IV_LENGTH),
  }
}

/** Convert a base64 string to a Uint8Array. */
export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Convert a Uint8Array to a base64 string, chunked for large data. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000 // 32KB chunks
  const chunks: string[] = []

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE)
    chunks.push(String.fromCharCode.apply(null, Array.from(chunk)))
  }

  return btoa(chunks.join(''))
}

/** Convert a Uint8Array to a base64url string (no padding, URL-safe alphabet). */
export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  return uint8ArrayToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Convert a base64url string to a Uint8Array. */
export function base64UrlToUint8Array(
  base64url: string,
): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return base64ToUint8Array(padded)
}

/** Convert a BufferSource (ArrayBuffer or ArrayBufferView) to a plain ArrayBuffer. */
export function bufferSourceToArrayBuffer(source: BufferSource): ArrayBuffer {
  if (source instanceof ArrayBuffer) {
    return source
  }
  return source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength,
  ) as ArrayBuffer
}

/**
 * Encrypt a raw attachment blob with a random per-attachment key.
 * Returns the ciphertext (IV || encrypted data) and the key material
 * so the caller can store the key in chat JSON metadata.
 */
export async function encryptAttachment(
  data: Uint8Array,
): Promise<{ encryptedData: Uint8Array; key: Uint8Array }> {
  const key = await crypto.subtle.generateKey(
    { name: AES_GCM, length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv },
    key,
    toBuffer(data),
  )

  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))

  return { encryptedData: packIvCiphertext(iv, ciphertext), key: rawKey }
}

/**
 * Decrypt a raw attachment blob using the per-attachment key.
 * The IV is extracted from the first 12 bytes of the encrypted data.
 */
export async function decryptAttachment(
  encryptedData: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== AES_256_KEY_LENGTH)
    throw new EncryptedAttachmentValidationError('invalid_key_length')
  const { iv, ciphertext } = unpackIvCiphertext(encryptedData)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(key),
    { name: AES_GCM },
    false,
    ['decrypt'],
  )

  const decrypted = await crypto.subtle.decrypt(
    { name: AES_GCM, iv: toBuffer(iv) },
    cryptoKey,
    toBuffer(ciphertext),
  )

  return new Uint8Array(decrypted)
}
