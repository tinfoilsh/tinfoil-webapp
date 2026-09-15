const TINFOIL_KEY_ID_INFO = new TextEncoder().encode('tinfoil-key-id-v1')
const CEK_BYTES = 32
const KEY_ID_BITS = 128

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export async function deriveTinfoilKeyIdHex(cek: Uint8Array): Promise<string> {
  if (cek.length !== CEK_BYTES) {
    throw new Error(`CEK must be exactly ${CEK_BYTES} bytes`)
  }
  const key = await crypto.subtle.importKey(
    'raw',
    cek as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const keyId = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: TINFOIL_KEY_ID_INFO,
    },
    key,
    KEY_ID_BITS,
  )
  return bytesToHex(new Uint8Array(keyId))
}
