import { LOCAL_PASSKEY_CREDENTIAL_ID } from '@/constants/storage-keys'

export function setLocalPasskeyCredentialId(credentialId: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LOCAL_PASSKEY_CREDENTIAL_ID, credentialId)
  } catch {
    // best-effort: storage quota / privacy mode failures must never
    // interrupt the passkey ceremony itself
  }
}

export function getLocalPasskeyCredentialId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(LOCAL_PASSKEY_CREDENTIAL_ID) || null
  } catch {
    return null
  }
}

export function clearLocalPasskeyCredentialId(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(LOCAL_PASSKEY_CREDENTIAL_ID)
  } catch {
    // best-effort
  }
}
