/**
 * HKDF-SHA256 derivations from the chat encryption key (chat KEK). Same
 * IKM, distinct info labels per RFC 5869 → independent outputs.
 *
 * Using the chat KEK as IKM means code-execution access travels with the
 * chats themselves: anyone who has the chat KEK (manual entry, passkey
 * recovery, etc.) can derive the code-exec encryption key and the
 * per-chat container auth token. Restoring chats to a new device also
 * restores code-exec access without a separate passkey ceremony.
 */

const HKDF_INFO_ENCRYPTION_KEY = 'tinfoil-code-execution-encryption-key-v1'
const HKDF_INFO_CONTAINER_AUTH_TOKEN_PREFIX = 'tinfoil-code-execution-v1:'

function toIkm(chatKEK: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (chatKEK instanceof Uint8Array) {
    return chatKEK.buffer.slice(
      chatKEK.byteOffset,
      chatKEK.byteOffset + chatKEK.byteLength,
    ) as ArrayBuffer
  }
  return chatKEK
}

async function hkdfDeriveBytes(
  chatKEK: ArrayBuffer | Uint8Array,
  infoString: string,
  byteLength: number,
): Promise<Uint8Array> {
  const ikm = toIkm(chatKEK)
  const masterKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ])
  const info = new TextEncoder().encode(infoString)
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Empty salt — high-entropy IKM (RFC 5869 §3.1).
      salt: new ArrayBuffer(0),
      info,
    },
    masterKey,
    byteLength * 8,
  )
  return new Uint8Array(derived)
}

export async function deriveCodeExecutionEncryptionKey(
  chatKEK: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  return hkdfDeriveBytes(chatKEK, HKDF_INFO_ENCRYPTION_KEY, 32)
}

export async function deriveCodeExecutionContainerAuthToken(
  chatKEK: ArrayBuffer | Uint8Array,
  chatId: string,
): Promise<Uint8Array> {
  return hkdfDeriveBytes(
    chatKEK,
    HKDF_INFO_CONTAINER_AUTH_TOKEN_PREFIX + chatId,
    32,
  )
}
