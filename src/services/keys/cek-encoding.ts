import { encryptionService } from '../encryption/encryption-service'
import { bytesToBase64 } from '../harness/keys'
import { deriveTinfoilKeyIdHex } from '../keys/tinfoil-key-id'
export function requirePrimaryKeyB64(): string {
  const bytes = encryptionService.getKeyBytesOrThrow()
  try {
    return bytesToBase64(bytes)
  } finally {
    bytes.fill(0)
  }
}
export const persistedPrimaryKeyB64 = requirePrimaryKeyB64
export const hasPrimaryKey = () => !!encryptionService.getKey()
export async function primaryKeyIdHex() {
  try {
    return await deriveTinfoilKeyIdHex(encryptionService.getKeyBytesOrThrow())
  } catch {
    return null
  }
}
