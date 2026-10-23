import { encryptionService } from '../encryption/encryption-service'
import { bytesToBase64 } from '../harness/keys'
export function requirePrimaryKeyB64(): string {
  const bytes = encryptionService.getKeyBytesOrThrow()
  try {
    return bytesToBase64(bytes)
  } finally {
    bytes.fill(0)
  }
}
