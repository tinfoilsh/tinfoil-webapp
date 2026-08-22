import { getLocalCredentialId, setLocalCredentialId } from './kit'

export function setLocalPasskeyCredentialId(credentialId: string): void {
  setLocalCredentialId(credentialId)
}

export function getLocalPasskeyCredentialId(): string | null {
  return getLocalCredentialId()
}
