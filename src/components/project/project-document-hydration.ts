import type {
  ProjectDocument,
  ProjectDocumentListResponse,
} from '@/types/project'

export function hydrateProjectDocuments(
  listedDocuments: ProjectDocumentListResponse['documents'],
  fullDocuments: Map<string, ProjectDocument>,
  previousDocuments: ProjectDocument[] = [],
): ProjectDocument[] {
  const previousById = new Map(previousDocuments.map((doc) => [doc.id, doc]))

  return listedDocuments.map((listed) => {
    const full = fullDocuments.get(listed.id)
    const previous = previousById.get(listed.id)

    if (!full || full.decryptionFailed) {
      if (previous?.content !== undefined && !previous.decryptionFailed) {
        return {
          ...previous,
          syncVersion: listed.syncVersion,
          createdAt: listed.createdAt,
          updatedAt: listed.updatedAt,
        }
      }

      return {
        ...listed,
        filename: full?.filename || '',
        contentType: full?.contentType || '',
        decryptionFailed: true,
      }
    }

    return {
      ...listed,
      content: full.content,
      thumbnailBase64: full.thumbnailBase64,
      filename: full.filename,
      contentType: full.contentType,
      sizeBytes: full.sizeBytes,
      decryptionFailed: false,
    }
  })
}
