/**
 * Tinfoil Buckets client — attested PUT for /user-uploads bucket entries.
 *
 * One bucket key per file (`fileAccessToken`); per-chat
 * `codeExecutionEncryptionKey` wraps every file in a chat. The buckets
 * enclave does the encryption: we send plaintext bytes + the wrapping
 * key over attested TLS, the enclave generates a DEK, encrypts in-memory,
 * and persists ciphertext to R2. The key is never persisted.
 */
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'

const BUCKETS_ENCLAVE =
  process.env.NEXT_PUBLIC_BUCKETS_BASE_URL || 'https://buckets.tinfoil.sh'
const BUCKETS_CONFIG_REPO = 'tinfoilsh/tinfoil-buckets'

let cachedClient: SecureClient | null = null

function getClient(): SecureClient {
  if (!cachedClient) {
    cachedClient = new SecureClient({
      enclaveURL: BUCKETS_ENCLAVE,
      configRepo: BUCKETS_CONFIG_REPO,
    })
  }
  return cachedClient
}

/**
 * Store an encrypted item in buckets. The enclave wraps `value` with a
 * fresh DEK and stores the wrapped DEK in a key slot keyed by
 * `encryptionKeyB64Std`.
 *
 * @param fileAccessToken  Bucket key (caller-chosen, treated as a password).
 * @param value            Plaintext bytes; base64-encoded on the wire.
 * @param encryptionKeyB64Std  AES-256 wrapping key, standard base64 with padding.
 * @param bearer           User's API key (Tinfoil session token), used for auth + tenant scoping.
 */
export async function putBucketItem(
  fileAccessToken: string,
  value: Uint8Array,
  encryptionKeyB64Std: string,
  bearer: string,
): Promise<void> {
  const client = getClient()
  const body = JSON.stringify({
    value: uint8ArrayToBase64(value),
    encryption_keys: [encryptionKeyB64Std],
  })

  const response = await client.fetch(
    `${BUCKETS_ENCLAVE}/items/${fileAccessToken}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body,
    },
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    logError(`buckets PUT failed: ${response.status}`, undefined, {
      component: 'buckets-client',
      action: 'putBucketItem',
      metadata: { status: response.status, error: errorText },
    })
    throw new Error(`buckets PUT failed: ${response.status}`)
  }
}
