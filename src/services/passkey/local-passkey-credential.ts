import { passkeyKit } from './kit'

export function setLocalPasskeyCredentialId(credentialId: string): void {
  passkeyKit.setLocalCredentialId(credentialId)
}

export function getLocalPasskeyCredentialId(): string | null {
  return passkeyKit.getLocalCredentialId()
}
