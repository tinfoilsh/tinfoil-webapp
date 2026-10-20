export function canDeleteAllProjects(isSignedIn: boolean): boolean {
  return isSignedIn
}

export function canTransferProjectData(isPremium: boolean): boolean {
  return isPremium
}
