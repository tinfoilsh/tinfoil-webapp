export interface ProjectUploadTarget {
  projectId: string
  isReady: boolean
}

type FileUploadRoutingOptions = {
  projectTarget: ProjectUploadTarget | null
  requestDestination: (file: File, target: ProjectUploadTarget) => void
  processFileForChat: (file: File) => Promise<void>
}

export function resolveProjectUploadTarget({
  activeProjectId,
  loadingProjectId,
}: {
  activeProjectId?: string
  loadingProjectId?: string
}): ProjectUploadTarget | null {
  if (loadingProjectId) {
    return { projectId: loadingProjectId, isReady: false }
  }
  if (activeProjectId) {
    return { projectId: activeProjectId, isReady: true }
  }
  return null
}

export async function routeChatFileUpload(
  file: File,
  {
    projectTarget,
    requestDestination,
    processFileForChat,
  }: FileUploadRoutingOptions,
): Promise<void> {
  if (projectTarget) {
    requestDestination(file, projectTarget)
    return
  }

  await processFileForChat(file)
}
