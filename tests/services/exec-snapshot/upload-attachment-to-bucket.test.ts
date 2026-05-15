import { uploadAttachmentToBucket } from '@/services/exec-snapshot/upload-attachment-to-bucket'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/buckets/buckets-client', () => ({
  putBucketItem: vi.fn().mockResolvedValue(undefined),
}))

const KNOWN_KEY_RAW = new Uint8Array(32).fill(7)
// base64url (no padding) of 32 bytes of 0x07.
const KNOWN_KEY_URL = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'
// standard base64 with padding of the same 32 bytes.
const KNOWN_KEY_STD = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
// sha256("hello") in hex.
const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

describe('uploadAttachmentToBucket', () => {
  it('hashes the bytes, mints a 64-hex token, and converts the key to standard base64', async () => {
    const file = new File([new TextEncoder().encode('hello')], 'hello.txt')
    const { putBucketItem } = await import('@/services/buckets/buckets-client')
    ;(putBucketItem as ReturnType<typeof vi.fn>).mockClear()

    const { fileAccessToken, sha256 } = await uploadAttachmentToBucket(
      file,
      KNOWN_KEY_URL,
      'bearer-tok',
    )

    expect(sha256).toBe(HELLO_SHA256)
    expect(fileAccessToken).toMatch(/^[0-9a-f]{64}$/)
    expect(putBucketItem).toHaveBeenCalledTimes(1)
    const [tokenArg, bytesArg, keyArg, bearerArg] = (
      putBucketItem as ReturnType<typeof vi.fn>
    ).mock.calls[0]
    expect(tokenArg).toBe(fileAccessToken)
    expect(Array.from(bytesArg as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode('hello')),
    )
    expect(keyArg).toBe(KNOWN_KEY_STD)
    expect(bearerArg).toBe('bearer-tok')
    void KNOWN_KEY_RAW // referenced for documentation
  })
})
