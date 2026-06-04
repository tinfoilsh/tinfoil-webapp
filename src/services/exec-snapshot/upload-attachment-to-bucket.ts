/**
 * Upload an attached file's raw bytes to buckets so it can be synced to
 * `/user-uploads` on the next code-execution call. One bucket entry per
 * file (`fileAccessToken`); per-chat `codeExecutionEncryptionKey`
 * wraps every file in the chat.
 *
 * Caller is responsible for gating: only invoke when
 * `canEnableCodeExecution && codeExecutionEncryptionKey` are both set.
 * On failure the caller should swallow + log; the attachment still works
 * for non-code-exec purposes (docling text, image rendering).
 */
import { putBucketItem } from '@/services/buckets/buckets-client'
import { base64UrlToUint8Array, uint8ArrayToBase64 } from '@/utils/binary-codec'

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function generateFileAccessToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return hexEncode(bytes)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as ArrayBuffer,
  )
  return hexEncode(new Uint8Array(digest))
}

export interface BucketUploadResult {
  fileAccessToken: string
  sha256: string
}

/**
 * Upload `file`'s raw bytes to a fresh bucket key and return the
 * coordinates needed to reference it in `code_execution_options.uploads`.
 *
 * @param file File from the picker.
 * @param codeExecutionEncryptionKeyB64Url  Per-chat key (base64url, no
 *   padding) — same value the inference request will carry as
 *   `code_execution_options.encryptionKey`.
 * @param bearer  User's API key for buckets auth.
 */
export async function uploadAttachmentToBucket(
  file: File,
  codeExecutionEncryptionKeyB64Url: string,
  bearer: string,
): Promise<BucketUploadResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha256 = await sha256Hex(bytes)
  const fileAccessToken = generateFileAccessToken()

  // Buckets accepts standard-padded base64 for encryption_keys.
  const keyStdB64 = uint8ArrayToBase64(
    base64UrlToUint8Array(codeExecutionEncryptionKeyB64Url),
  )

  await putBucketItem(fileAccessToken, bytes, keyStdB64, bearer)

  return { fileAccessToken, sha256 }
}
