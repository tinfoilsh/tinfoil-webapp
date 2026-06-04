/**
 * Tinfoil Buckets client — attested PUT against the tinfoil-bucket S3 enclave.
 *
 * Wire format (per smoke spec):
 *   PUT  {ENCLAVE}/{BUCKET}/{key}
 *   Authorization: Bearer <user api key>          // proxy validates + strips
 *   X-Tinfoil-Encryption-Key: <std-padded b64>    // per-request AES-256 key
 *   <raw bytes>
 *
 * The bucket name in the URL path is a stand-in: the sidecar always writes
 * to its server-configured bucket, so any non-empty string works. The
 * proxy stamps `X-Tinfoil-Tenant-Id` from the validated bearer; objects
 * land under a per-user prefix server-side.
 */
import { logError } from '@/utils/error-handling'
import { SecureClient } from 'tinfoil'

const BUCKETS_ENCLAVE =
  process.env.NEXT_PUBLIC_BUCKETS_BASE_URL || 'https://bucket.tinfoil.sh'
const BUCKETS_CONFIG_REPO = 'tinfoilsh/tinfoil-bucket'
const BUCKETS_URL_BUCKET = 'tinfoil-bucket'

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
 * Store raw bytes in the buckets enclave under `fileAccessToken`. The enclave
 * encrypts in-memory with the supplied AES-256 key and persists ciphertext;
 * the key never leaves the browser → enclave path.
 *
 * @param fileAccessToken      S3 object key (caller-chosen, opaque).
 * @param value                Plaintext bytes; sent as the PUT body.
 * @param encryptionKeyB64Std  AES-256 key, standard base64 with padding.
 * @param bearer               User's Tinfoil API key.
 */
export async function putBucketItem(
  fileAccessToken: string,
  value: Uint8Array,
  encryptionKeyB64Std: string,
  bearer: string,
): Promise<void> {
  const client = getClient()
  const url = `${BUCKETS_ENCLAVE}/${BUCKETS_URL_BUCKET}/${fileAccessToken}`

  const response = await client.fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'X-Tinfoil-Encryption-Key': encryptionKeyB64Std,
      'Content-Type': 'application/octet-stream',
    },
    body: value as BodyInit,
  })

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
