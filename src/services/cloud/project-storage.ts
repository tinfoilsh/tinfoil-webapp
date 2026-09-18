import type {
  CreateProjectData,
  Project,
  ProjectData,
  ProjectDocument,
  ProjectDocumentListResponse,
  ProjectDocumentSyncStatus,
  ProjectListResponse,
  ProjectSyncStatus,
  UpdateProjectData,
} from '@/types/project'
import { logError } from '@/utils/error-handling'
import { authTokenManager } from '../auth'
import {
  deleteAllProjects as enclaveDeleteAllProjects,
  deleteRow as enclaveDeleteRow,
  listStatus as enclaveListStatus,
  pull as enclavePull,
  push as enclavePush,
  newIdempotencyKey,
  pullItemPlaintext,
  SyncEnclaveError,
  type PullItem,
} from '../sync-enclave/sync-api'
import type { AccountOperationGuard } from './account-operation'
import {
  CloudBackupReadError,
  groupBackupPullItems,
  validateBackupPullItem,
  type BackupPullResult,
} from './backup-read-error'
import { pullKey, requirePrimaryKeyB64 } from './cek-encoding'
import { canWriteToCloud } from './cloud-key-authorization'
import { ProjectDataSchema, ProjectDocumentPlaintextSchema } from './schemas'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

const PROJECT_SCOPE = 'project'
const PROJECT_DOCUMENT_SCOPE = 'project_document'
const ENCLAVE_PROJECT_LIST_LIMIT = 100

function projectDocumentId(projectId: string, documentId: string): string {
  return `${projectId}/${documentId}`
}

function unavailableProjectDocument(
  projectId: string,
  documentId: string,
): ProjectDocument {
  const now = new Date().toISOString()
  return {
    id: documentId,
    projectId,
    filename: '',
    contentType: '',
    sizeBytes: 0,
    syncVersion: 1,
    createdAt: now,
    updatedAt: now,
    decryptionFailed: true,
  }
}

function resolveDocumentSizeBytes(
  content: string,
  persistedSizeBytes?: number,
): number {
  return persistedSizeBytes ?? new TextEncoder().encode(content).length
}

// The legacy controlplane row exposed a numeric `syncVersion` to the
// client. The enclave protocol carries the same monotonic counter as a
// string ETag (§7 of the sync spec). The Project type still requires a
// number, so we parse the decimal etag back. Non-numeric etags fall
// back to 1 to keep the type contract intact; the next sync pass
// refreshes the real value from the controlplane listing.
function etagToSyncVersion(etag: string | undefined): number {
  if (!etag) return 1
  const parsed = parseInt(etag, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function createdAtFromReverseId(id: string): string {
  const reverse = parseInt(id.split('_')[0] ?? '', 10)
  if (!Number.isFinite(reverse)) {
    return new Date().toISOString()
  }
  return new Date(9999999999999 - reverse).toISOString()
}

function hasNextCursor(cursor: string | undefined): boolean {
  return typeof cursor === 'string' && cursor.length > 0
}

function projectDocumentListItemFromStatus(update: {
  id: string
  etag: string
  updated_at: string
}): ProjectDocumentListResponse['documents'][number] {
  const slash = update.id.indexOf('/')
  const projectId = slash >= 0 ? update.id.slice(0, slash) : ''
  const documentId = slash >= 0 ? update.id.slice(slash + 1) : update.id
  return {
    id: documentId,
    projectId,
    sizeBytes: 0,
    syncVersion: etagToSyncVersion(update.etag),
    createdAt: createdAtFromReverseId(documentId),
    updatedAt: update.updated_at,
  }
}

export class ProjectStorageService {
  private async getHeaders(): Promise<Record<string, string>> {
    return authTokenManager.getAuthHeaders()
  }

  async isAuthenticated(): Promise<boolean> {
    return authTokenManager.isAuthenticated()
  }

  async generateProjectId(): Promise<{
    projectId: string
    timestamp: string
    reverseTimestamp: number
  }> {
    const response = await fetch(`${API_BASE_URL}/api/projects/generate-id`, {
      method: 'POST',
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to generate project ID: ${response.statusText}`)
    }

    return response.json()
  }

  async createProject(data: CreateProjectData): Promise<Project> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const { projectId } = await this.generateProjectId()

    const projectData: ProjectData = {
      name: data.name,
      description: data.description || '',
      systemInstructions: data.systemInstructions || '',
      color: data.color,
      memory: [],
    }

    const plaintext = new TextEncoder().encode(JSON.stringify(projectData))

    const pushResp = await enclavePush({
      scope: PROJECT_SCOPE,
      id: projectId,
      keyB64: requirePrimaryKeyB64(),
      plaintext,
      ifMatch: null,
      idempotencyKey: newIdempotencyKey(),
      metadata: {},
    })

    const now = new Date().toISOString()
    return {
      id: projectId,
      ...projectData,
      createdAt: now,
      updatedAt: now,
      syncVersion: etagToSyncVersion(pushResp.etag),
    }
  }

  async updateProject(
    projectId: string,
    data: UpdateProjectData,
  ): Promise<Project> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const existing = await this.getProject(projectId)
    if (!existing) {
      throw new Error('Project not found')
    }

    const projectData: ProjectData = {
      name: data.name ?? existing.name,
      description: data.description ?? existing.description,
      systemInstructions:
        data.systemInstructions ?? existing.systemInstructions,
      color: data.color ?? existing.color,
      memory: data.memory ?? existing.memory,
    }

    const plaintext = new TextEncoder().encode(JSON.stringify(projectData))

    const pushResp = await enclavePush({
      scope: PROJECT_SCOPE,
      id: projectId,
      keyB64: requirePrimaryKeyB64(),
      plaintext,
      ifMatch: String(existing.syncVersion),
      idempotencyKey: newIdempotencyKey(),
      metadata: {},
    })

    return {
      id: projectId,
      ...projectData,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      syncVersion: etagToSyncVersion(pushResp.etag),
    }
  }

  async getProject(
    projectId: string,
    options: { strictBackupRead?: boolean } = {},
  ): Promise<Project | null> {
    try {
      const keys = pullKey()
      if (keys.length === 0) {
        if (options.strictBackupRead)
          throw new CloudBackupReadError(
            'key_unavailable',
            'cloud_key_unavailable',
            false,
          )
        return null
      }

      const resp = await enclavePull({
        scope: PROJECT_SCOPE,
        ids: [projectId],
        keys,
      })
      const item = resp.items[0]
      if (!item || !item.ok) {
        if (item && item.code === 'NOT_FOUND') return null
        if (options.strictBackupRead)
          throw new SyncEnclaveError(
            'Project pull returned an invalid item',
            undefined,
            item?.code,
          )
        return null
      }
      const plaintextBytes = pullItemPlaintext(item)
      if (!plaintextBytes) {
        if (options.strictBackupRead)
          throw new CloudBackupReadError(
            'item_invalid',
            'project_payload_unavailable',
            true,
          )
        return null
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
      } catch (error) {
        if (options.strictBackupRead && error instanceof SyntaxError)
          throw new CloudBackupReadError(
            'item_invalid',
            'project_payload_invalid',
            true,
            { cause: error },
          )
        throw error
      }
      const projectValidation = ProjectDataSchema.safeParse(parsed)
      if (!projectValidation.success) {
        if (options.strictBackupRead)
          throw new CloudBackupReadError(
            'item_invalid',
            'project_payload_invalid',
            true,
            { cause: projectValidation.error },
          )
        logError('Discarding project with invalid shape', undefined, {
          component: 'ProjectStorage',
          action: 'getProject',
          metadata: { projectId, issues: projectValidation.error.message },
        })
        return null
      }
      const decoded = parsed as ProjectData

      // PullItem only carries the row body + etag; createdAt/updatedAt
      // come from the controlplane listing path (listProjects /
      // getProjectsUpdatedSince), so we synthesize a "now" stamp here
      // and let the next sync pass overwrite it with the authoritative
      // value.
      const now = new Date().toISOString()
      return {
        id: projectId,
        name: decoded.name,
        description: decoded.description,
        systemInstructions: decoded.systemInstructions,
        color: decoded.color,
        memory: decoded.memory || [],
        createdAt: now,
        updatedAt: now,
        syncVersion: etagToSyncVersion(item.etag),
      }
    } catch (error) {
      if (options.strictBackupRead) throw error
      logError(`Failed to get project ${projectId}`, error, {
        component: 'ProjectStorage',
        action: 'getProject',
        metadata: { projectId },
      })
      return null
    }
  }

  /**
   * Batched strict backup read for projects: one enclave round trip,
   * each item validated against its captured inventory ETag. Results
   * align positionally with `requests` and settle per record.
   */
  async getProjectsForBackup(
    requests: ReadonlyArray<{ id: string; expectedEtag: string }>,
  ): Promise<BackupPullResult<Project | null>[]> {
    return this.pullBatchForBackup(
      PROJECT_SCOPE,
      requests.map(({ id, expectedEtag }) => ({
        wireId: id,
        expectedEtag,
      })),
      (item, index) => this.decodeProjectBackupItem(item, requests[index].id),
    )
  }

  private async pullBatchForBackup<T>(
    scope: typeof PROJECT_SCOPE | typeof PROJECT_DOCUMENT_SCOPE,
    requests: ReadonlyArray<{ wireId: string; expectedEtag: string }>,
    decode: (item: PullItem, index: number) => T | null,
  ): Promise<BackupPullResult<T | null>[]> {
    if (requests.length === 0) return []
    const keys = pullKey()
    if (keys.length === 0)
      throw new CloudBackupReadError(
        'key_unavailable',
        'cloud_key_unavailable',
        false,
      )
    const resp = await enclavePull({
      scope,
      ids: requests.map(({ wireId }) => wireId),
      keys,
    })
    const grouped = groupBackupPullItems(
      resp.items,
      requests.map(({ wireId }) => wireId),
    )
    return requests.map(({ wireId, expectedEtag }, index) => {
      try {
        const item = validateBackupPullItem(
          grouped.get(wireId) ?? [],
          wireId,
          expectedEtag,
        )
        // validateBackupPullItem throws for NOT_FOUND, so any failed
        // item that survives it carries an unexpected error code.
        if (!item.ok)
          throw new SyncEnclaveError(
            'Backup pull returned an invalid item',
            undefined,
            item.code,
          )
        return { ok: true as const, value: decode(item, index) }
      } catch (error) {
        return { ok: false as const, error }
      }
    })
  }

  private decodeProjectBackupItem(
    item: PullItem,
    projectId: string,
  ): Project | null {
    const plaintextBytes = pullItemPlaintext(item)
    if (!plaintextBytes)
      throw new CloudBackupReadError(
        'item_invalid',
        'project_payload_unavailable',
        true,
      )
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new CloudBackupReadError(
          'item_invalid',
          'project_payload_invalid',
          true,
          { cause: error },
        )
      throw error
    }
    const projectValidation = ProjectDataSchema.safeParse(parsed)
    if (!projectValidation.success)
      throw new CloudBackupReadError(
        'item_invalid',
        'project_payload_invalid',
        true,
        { cause: projectValidation.error },
      )
    const decoded = parsed as ProjectData

    // Same timestamp-synthesis rationale as getProject: the
    // controlplane listing path owns the authoritative values.
    const now = new Date().toISOString()
    return {
      id: projectId,
      name: decoded.name,
      description: decoded.description,
      systemInstructions: decoded.systemInstructions,
      color: decoded.color,
      memory: decoded.memory || [],
      createdAt: now,
      updatedAt: now,
      syncVersion: etagToSyncVersion(item.etag),
    }
  }

  // Batch variant of getProject: pulls every requested project in a
  // single enclave round-trip and returns the decoded Project objects
  // keyed by id. Missing or decryption-failed ids are simply absent
  // from the result Map, so callers can fall back as needed.
  async getProjects(projectIds: string[]): Promise<Map<string, Project>> {
    const result = new Map<string, Project>()
    if (projectIds.length === 0) return result

    try {
      const keys = pullKey()
      if (keys.length === 0) return result

      const resp = await enclavePull({
        scope: PROJECT_SCOPE,
        ids: projectIds,
        keys,
      })

      for (const item of resp.items) {
        if (!item.ok) continue
        const plaintextBytes = pullItemPlaintext(item)
        if (!plaintextBytes) continue
        try {
          const parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
          const projectValidation = ProjectDataSchema.safeParse(parsed)
          if (!projectValidation.success) {
            logError('Skipping project with invalid shape', undefined, {
              component: 'ProjectStorage',
              action: 'getProjects',
              metadata: {
                id: item.id,
                issues: projectValidation.error.message,
              },
            })
            continue
          }
          const decoded = parsed as ProjectData
          const now = new Date().toISOString()
          result.set(item.id, {
            id: item.id,
            name: decoded.name,
            description: decoded.description,
            systemInstructions: decoded.systemInstructions,
            color: decoded.color,
            memory: decoded.memory || [],
            createdAt: now,
            updatedAt: now,
            syncVersion: etagToSyncVersion(item.etag),
          })
        } catch (decodeErr) {
          logError(`Failed to decode project ${item.id}`, decodeErr, {
            component: 'ProjectStorage',
            action: 'getProjects',
            metadata: { projectId: item.id },
          })
        }
      }
      return result
    } catch (error) {
      // A failed batch pull is a transport/sync error, not "every
      // project is encrypted" — rethrow so the caller can surface an
      // error state instead of rendering placeholder projects.
      logError('Failed to batch-get projects', error, {
        component: 'ProjectStorage',
        action: 'getProjects',
        metadata: { count: projectIds.length },
      })
      throw error
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    // A UI-driven single-row delete passes `if_match=null`. The
    // enclave retries on STALE_BLOB up to three
    // times, so we do not need to fetch the current etag first. The
    // previous approach scanned only the first 500 list-status rows
    // and silently no-op'd when the target lived past the boundary.
    await enclaveDeleteRow({
      scope: PROJECT_SCOPE,
      id: projectId,
      ifMatch: null,
      idempotencyKey: newIdempotencyKey(),
      keyB64: requirePrimaryKeyB64(),
    })
  }

  async deleteAllProjects(guard: AccountOperationGuard): Promise<number> {
    guard.assertCurrent()
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    guard.assertCurrent()
    const response = await enclaveDeleteAllProjects({
      keyB64: requirePrimaryKeyB64(),
      idempotencyKey: newIdempotencyKey(),
    })
    guard.assertCurrent()
    return response.deleted
  }

  async listProjects(options?: {
    limit?: number
    continuationToken?: string
    includeContent?: boolean
  }): Promise<ProjectListResponse> {
    const limit = Math.min(options?.limit ?? ENCLAVE_PROJECT_LIST_LIMIT, 500)
    const status = await enclaveListStatus({
      scope: PROJECT_SCOPE,
      cursor: options?.continuationToken,
      limit,
      direction: 'desc',
    })
    return {
      projects: status.updates.map((update) => ({
        id: update.id,
        key: update.id,
        createdAt: createdAtFromReverseId(update.id),
        updatedAt: update.updated_at,
        syncVersion: etagToSyncVersion(update.etag),
        size: 0,
      })),
      nextContinuationToken: status.next_cursor,
      hasMore: hasNextCursor(status.next_cursor),
    }
  }

  async getProjectSyncStatus(): Promise<ProjectSyncStatus> {
    let count = 0
    let lastUpdated: string | null = null
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: PROJECT_SCOPE,
        cursor,
        limit: 500,
      })
      count += status.updates.length
      for (const update of status.updates) {
        if (!lastUpdated || update.updated_at > lastUpdated) {
          lastUpdated = update.updated_at
        }
      }
      cursor = status.next_cursor
    } while (cursor)
    return { count, lastUpdated }
  }

  async getProjectsUpdatedSince(options: {
    since: string
    continuationToken?: string
  }): Promise<ProjectListResponse> {
    let cursor: string | undefined = options.continuationToken ?? options.since
    let nextContinuationToken: string | undefined
    const projects: ProjectListResponse['projects'] = []
    do {
      const status = await enclaveListStatus({
        scope: PROJECT_SCOPE,
        cursor,
        limit: ENCLAVE_PROJECT_LIST_LIMIT,
      })
      projects.push(
        ...status.updates
          .filter((update) => update.updated_at > options.since)
          .map((update) => ({
            id: update.id,
            key: update.id,
            createdAt: createdAtFromReverseId(update.id),
            updatedAt: update.updated_at,
            syncVersion: etagToSyncVersion(update.etag),
            size: 0,
          })),
      )
      cursor = status.next_cursor
      nextContinuationToken = status.next_cursor
    } while (
      projects.length < ENCLAVE_PROJECT_LIST_LIMIT &&
      hasNextCursor(cursor)
    )

    return {
      projects,
      nextContinuationToken,
      hasMore: hasNextCursor(nextContinuationToken),
    }
  }

  async generateDocumentId(projectId: string): Promise<{
    documentId: string
    timestamp: string
    reverseTimestamp: number
  }> {
    const response = await fetch(
      `${API_BASE_URL}/api/projects/${projectId}/documents/generate-id`,
      {
        method: 'POST',
        headers: await this.getHeaders(),
      },
    )

    if (!response.ok) {
      throw new Error(`Failed to generate document ID: ${response.statusText}`)
    }

    return response.json()
  }

  async uploadDocument(
    projectId: string,
    filename: string,
    contentType: string,
    content: string,
    sizeBytes?: number,
    thumbnailBase64?: string,
  ): Promise<ProjectDocument> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const { documentId } = await this.generateDocumentId(projectId)

    const persistedSizeBytes = resolveDocumentSizeBytes(content, sizeBytes)
    const docPayload = {
      content,
      filename,
      contentType,
      sizeBytes: persistedSizeBytes,
      ...(thumbnailBase64 ? { thumbnailBase64 } : {}),
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(docPayload))

    const pushResp = await enclavePush({
      scope: PROJECT_DOCUMENT_SCOPE,
      id: projectDocumentId(projectId, documentId),
      keyB64: requirePrimaryKeyB64(),
      plaintext,
      ifMatch: null,
      idempotencyKey: newIdempotencyKey(),
      metadata: { filename, contentType, projectId },
    })

    const now = new Date().toISOString()
    return {
      id: documentId,
      projectId,
      filename,
      contentType,
      sizeBytes: persistedSizeBytes,
      syncVersion: etagToSyncVersion(pushResp.etag),
      createdAt: now,
      updatedAt: now,
      content,
      thumbnailBase64,
    }
  }

  async getDocument(
    projectId: string,
    documentId: string,
    options: { strictBackupRead?: boolean } = {},
  ): Promise<ProjectDocument | null> {
    try {
      const keys = pullKey()
      if (keys.length === 0) {
        if (options.strictBackupRead)
          throw new CloudBackupReadError(
            'key_unavailable',
            'cloud_key_unavailable',
            false,
          )
        return null
      }

      const resp = await enclavePull({
        scope: PROJECT_DOCUMENT_SCOPE,
        ids: [projectDocumentId(projectId, documentId)],
        keys,
      })
      const item = resp.items[0]
      if (!item || !item.ok) {
        if (item && item.code === 'NOT_FOUND') return null
        if (options.strictBackupRead)
          throw new SyncEnclaveError(
            'Project document pull returned an invalid item',
            undefined,
            item?.code,
          )
        return null
      }
      const plaintextBytes = pullItemPlaintext(item)
      if (!plaintextBytes) {
        if (options.strictBackupRead)
          throw new CloudBackupReadError(
            'item_invalid',
            'document_payload_unavailable',
            true,
          )
        return null
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
      } catch (error) {
        if (options.strictBackupRead && error instanceof SyntaxError)
          throw new CloudBackupReadError(
            'item_invalid',
            'document_payload_invalid',
            true,
            { cause: error },
          )
        throw error
      }
      const documentValidation =
        ProjectDocumentPlaintextSchema.safeParse(parsed)
      if (!documentValidation.success) {
        if (options.strictBackupRead)
          throw new CloudBackupReadError(
            'item_invalid',
            'document_payload_invalid',
            true,
            { cause: documentValidation.error },
          )
        logError('Discarding document with invalid shape', undefined, {
          component: 'ProjectStorage',
          action: 'getDocument',
          metadata: { documentId, issues: documentValidation.error.message },
        })
        return null
      }
      const decoded = documentValidation.data

      // Same timestamp-synthesis rationale as getProject: the
      // controlplane listing path owns the authoritative values.
      const now = new Date().toISOString()
      return {
        id: documentId,
        projectId,
        filename: decoded.filename || '',
        contentType: decoded.contentType || '',
        sizeBytes: resolveDocumentSizeBytes(decoded.content, decoded.sizeBytes),
        syncVersion: etagToSyncVersion(item.etag),
        createdAt: now,
        updatedAt: now,
        content: decoded.content,
        thumbnailBase64: decoded.thumbnailBase64,
      }
    } catch (error) {
      if (options.strictBackupRead) throw error
      logError(`Failed to get document ${documentId}`, error, {
        component: 'ProjectStorage',
        action: 'getDocument',
        metadata: { projectId, documentId },
      })
      return null
    }
  }

  /**
   * Batched strict backup read for project documents: one enclave
   * round trip, each item validated against its captured inventory
   * ETag. Results align positionally with `requests`.
   */
  async getDocumentsForBackup(
    requests: ReadonlyArray<{
      projectId: string
      id: string
      expectedEtag: string
    }>,
  ): Promise<BackupPullResult<ProjectDocument | null>[]> {
    return this.pullBatchForBackup(
      PROJECT_DOCUMENT_SCOPE,
      requests.map(({ projectId, id, expectedEtag }) => ({
        wireId: projectDocumentId(projectId, id),
        expectedEtag,
      })),
      (item, index) =>
        this.decodeDocumentBackupItem(
          item,
          requests[index].projectId,
          requests[index].id,
        ),
    )
  }

  private decodeDocumentBackupItem(
    item: PullItem,
    projectId: string,
    documentId: string,
  ): ProjectDocument | null {
    const plaintextBytes = pullItemPlaintext(item)
    if (!plaintextBytes)
      throw new CloudBackupReadError(
        'item_invalid',
        'document_payload_unavailable',
        true,
      )
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new CloudBackupReadError(
          'item_invalid',
          'document_payload_invalid',
          true,
          { cause: error },
        )
      throw error
    }
    const documentValidation = ProjectDocumentPlaintextSchema.safeParse(parsed)
    if (!documentValidation.success)
      throw new CloudBackupReadError(
        'item_invalid',
        'document_payload_invalid',
        true,
        { cause: documentValidation.error },
      )
    const decoded = documentValidation.data

    // Same timestamp-synthesis rationale as getProject: the
    // controlplane listing path owns the authoritative values.
    const now = new Date().toISOString()
    return {
      id: documentId,
      projectId,
      filename: decoded.filename || '',
      contentType: decoded.contentType || '',
      sizeBytes: resolveDocumentSizeBytes(decoded.content, decoded.sizeBytes),
      syncVersion: etagToSyncVersion(item.etag),
      createdAt: now,
      updatedAt: now,
      content: decoded.content,
      thumbnailBase64: decoded.thumbnailBase64,
    }
  }

  // Batch variant of getDocument: pulls every requested document for a
  // project in a single enclave round-trip and returns the decoded
  // ProjectDocument objects keyed by id. Unavailable rows are represented
  // explicitly so callers never mistake a pull failure for an empty file.
  async getDocuments(
    projectId: string,
    documentIds: string[],
  ): Promise<Map<string, ProjectDocument>> {
    const result = new Map<string, ProjectDocument>()
    if (documentIds.length === 0) return result

    try {
      const keys = pullKey()
      if (keys.length === 0) return result

      const compositeIds = documentIds.map((id) =>
        projectDocumentId(projectId, id),
      )
      const compositeToOriginal = new Map<string, string>()
      compositeIds.forEach((composite, idx) => {
        compositeToOriginal.set(composite, documentIds[idx])
      })

      const resp = await enclavePull({
        scope: PROJECT_DOCUMENT_SCOPE,
        ids: compositeIds,
        keys,
      })

      for (const item of resp.items) {
        const originalId = compositeToOriginal.get(item.id)
        if (!originalId) continue
        if (!item.ok) {
          result.set(
            originalId,
            unavailableProjectDocument(projectId, originalId),
          )
          logError('Failed to pull project document', undefined, {
            component: 'ProjectStorage',
            action: 'getDocuments',
            metadata: {
              projectId,
              documentId: originalId,
              code: item.code,
            },
          })
          continue
        }
        const plaintextBytes = pullItemPlaintext(item)
        if (!plaintextBytes) {
          result.set(
            originalId,
            unavailableProjectDocument(projectId, originalId),
          )
          continue
        }
        try {
          const documentValidation = ProjectDocumentPlaintextSchema.safeParse(
            JSON.parse(new TextDecoder().decode(plaintextBytes)),
          )
          if (!documentValidation.success) {
            logError('Skipping document with invalid shape', undefined, {
              component: 'ProjectStorage',
              action: 'getDocuments',
              metadata: {
                id: originalId,
                issues: documentValidation.error.message,
              },
            })
            result.set(
              originalId,
              unavailableProjectDocument(projectId, originalId),
            )
            continue
          }
          const decoded = documentValidation.data
          const now = new Date().toISOString()
          result.set(originalId, {
            id: originalId,
            projectId,
            filename: decoded.filename || '',
            contentType: decoded.contentType || '',
            sizeBytes: resolveDocumentSizeBytes(
              decoded.content,
              decoded.sizeBytes,
            ),
            syncVersion: etagToSyncVersion(item.etag),
            createdAt: now,
            updatedAt: now,
            content: decoded.content,
            thumbnailBase64: decoded.thumbnailBase64,
          })
        } catch (decodeErr) {
          logError(`Failed to decode document ${originalId}`, decodeErr, {
            component: 'ProjectStorage',
            action: 'getDocuments',
            metadata: { projectId, documentId: originalId },
          })
          result.set(
            originalId,
            unavailableProjectDocument(projectId, originalId),
          )
        }
      }
      for (const documentId of documentIds) {
        if (!result.has(documentId)) {
          result.set(
            documentId,
            unavailableProjectDocument(projectId, documentId),
          )
        }
      }
      return result
    } catch (error) {
      // A failed batch pull is a transport/sync error, not "every
      // document is missing" — rethrow so the caller can surface an
      // error state instead of rendering blank placeholder documents.
      logError('Failed to batch-get documents', error, {
        component: 'ProjectStorage',
        action: 'getDocuments',
        metadata: { projectId, count: documentIds.length },
      })
      throw error
    }
  }

  async deleteDocument(projectId: string, documentId: string): Promise<void> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const id = projectDocumentId(projectId, documentId)
    // A UI-driven single-row delete passes `if_match=null`. The
    // PROJECT_DOCUMENT_SCOPE pools every
    // project's documents under one user, so the previous
    // first-page-only list-status lookup was even more likely to
    // miss the target than the project case.
    await enclaveDeleteRow({
      scope: PROJECT_DOCUMENT_SCOPE,
      id,
      ifMatch: null,
      idempotencyKey: newIdempotencyKey(),
      keyB64: requirePrimaryKeyB64(),
    })
  }

  async listDocuments(
    projectId: string,
    _options?: { includeContent?: boolean },
  ): Promise<ProjectDocumentListResponse> {
    // Deduplicate by id: list-status walks the whole scope ordered by
    // updated_at, so a row whose updated_at is bumped mid-walk (e.g.
    // the enclave's rewrap-on-pull) or that straddles a page boundary
    // can be returned twice. Keep the freshest copy of each row.
    const documentsById = new Map<
      string,
      ProjectDocumentListResponse['documents'][number]
    >()
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: PROJECT_DOCUMENT_SCOPE,
        cursor,
        limit: 500,
      })
      for (const update of status.updates) {
        if (!update.id.startsWith(`${projectId}/`)) continue
        const document = projectDocumentListItemFromStatus(update)
        const existing = documentsById.get(document.id)
        if (!existing || document.updatedAt >= existing.updatedAt) {
          documentsById.set(document.id, document)
        }
      }
      cursor = status.next_cursor
    } while (cursor)
    // Replacing a Map value keeps its original insertion position, so
    // re-sort to preserve the updated_at ordering of the walk.
    const documents = Array.from(documentsById.values()).sort((a, b) =>
      a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
    )
    return { documents }
  }

  async getDocumentSyncStatus(
    projectId: string,
  ): Promise<ProjectDocumentSyncStatus> {
    const { documents } = await this.listDocuments(projectId)
    const lastUpdated = documents.reduce<string | null>(
      (latest, doc) =>
        !latest || doc.updatedAt > latest ? doc.updatedAt : latest,
      null,
    )
    return { count: documents.length, lastUpdated }
  }
}

export const projectStorage = new ProjectStorageService()
