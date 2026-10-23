import {
  getLocalCredentialId,
  getRoamingCredentialIds,
  setLocalCredentialId,
} from './kit'

export function setLocalPasskeyCredentialId(credentialId: string): void {
  setLocalCredentialId(credentialId)
}

export function getLocalPasskeyCredentialId(): string | null {
  return getLocalCredentialId()
}

export function getRoamingPasskeyCredentialIds(): string[] {
  return getRoamingCredentialIds()
}

export function getThisDevicePasskeyCredentialIds(): string[] {
  const localCredentialId = getLocalCredentialId()
  const roamingCredentialIds = getRoamingCredentialIds()
  return localCredentialId
    ? [localCredentialId, ...roamingCredentialIds]
    : roamingCredentialIds
}
