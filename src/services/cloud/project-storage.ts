import type {
  CreateProjectData,
  Project,
  ProjectChatListResponse,
  ProjectChatSyncStatus,
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
  deleteRow as enclaveDeleteRow,
  listStatus as enclaveListStatus,
  pull as enclavePull,
  push as enclavePush,
  newIdempotencyKey,
  pullItemPlaintext,
} from '../sync-enclave/sync-api'
import { pullKey, requirePrimaryKeyB64 } from './cek-encoding'
import { canWriteToCloud } from './cloud-key-authorization'
import { ProjectDataSchema, ProjectDocumentPlaintextSchema } from './schemas'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

const PROJECT_SCOPE = 'project'
const PROJECT_DOCUMENT_SCOPE = 'project_document'
const CHAT_SCOPE = 'chat'
const ENCLAVE_PROJECT_LIST_LIMIT = 100
const ENCLAVE_PROJECT_CHAT_LIST_LIMIT = 100

function projectDocumentId(projectId: string, documentId: string): string {
  return `${projectId}/${documentId}`
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

function projectChatFromStatus(update: {
  id: string
  etag: string
  updated_at: string
  project_id?: string | null
}): ProjectChatListResponse['chats'][number] {
  return {
    id: update.id,
    projectId: update.project_id ?? '',
    messageCount: 0,
    syncVersion: etagToSyncVersion(update.etag),
    size: 0,
    formatVersion: 2,
    createdAt: createdAtFromReverseId(update.id),
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
  ): Promise<void> {
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

    await enclavePush({
      scope: PROJECT_SCOPE,
      id: projectId,
      keyB64: requirePrimaryKeyB64(),
      plaintext,
      ifMatch: String(existing.syncVersion),
      idempotencyKey: newIdempotencyKey(),
      metadata: {},
    })
  }

  async getProject(projectId: string): Promise<Project | null> {
    try {
      const keys = pullKey()
      if (keys.length === 0) return null

      const resp = await enclavePull({
        scope: PROJECT_SCOPE,
        ids: [projectId],
        keys,
      })
      const item = resp.items[0]
      if (!item || !item.ok) {
        if (item && item.code === 'NOT_FOUND') return null
        return null
      }
      const plaintextBytes = pullItemPlaintext(item)
      if (!plaintextBytes) return null

      const parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
      const projectValidation = ProjectDataSchema.safeParse(parsed)
      if (!projectValidation.success) {
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
      logError(`Failed to get project ${projectId}`, error, {
        component: 'ProjectStorage',
        action: 'getProject',
        metadata: { projectId },
      })
      return null
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

  async deleteAllProjects(): Promise<{
    deleted: number
    notificationSent?: boolean
  }> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    let deleted = 0
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: PROJECT_SCOPE,
        cursor,
        limit: 500,
      })
      for (const update of status.updates) {
        // Bulk delete-all is unconditional: user intent is "drop
        // everything", and the listed etag can become stale between
        // the page fetch and the delete (concurrent write from another
        // device). Passing ifMatch=null avoids spurious STALE_BLOB
        // failures that would leave the batch partially completed.
        // Mirrors the single-row deleteProject path.
        await enclaveDeleteRow({
          scope: PROJECT_SCOPE,
          id: update.id,
          ifMatch: null,
          idempotencyKey: newIdempotencyKey(),
          keyB64: requirePrimaryKeyB64(),
        })
        deleted++
      }
      cursor = status.next_cursor
    } while (cursor)
    return { deleted }
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
  ): Promise<ProjectDocument> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const { documentId } = await this.generateDocumentId(projectId)

    const docPayload = { content, filename, contentType }
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
      sizeBytes: new TextEncoder().encode(content).length,
      syncVersion: etagToSyncVersion(pushResp.etag),
      createdAt: now,
      updatedAt: now,
      content,
    }
  }

  async getDocument(
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocument | null> {
    try {
      const keys = pullKey()
      if (keys.length === 0) return null

      const resp = await enclavePull({
        scope: PROJECT_DOCUMENT_SCOPE,
        ids: [projectDocumentId(projectId, documentId)],
        keys,
      })
      const item = resp.items[0]
      if (!item || !item.ok) {
        if (item && item.code === 'NOT_FOUND') return null
        return null
      }
      const plaintextBytes = pullItemPlaintext(item)
      if (!plaintextBytes) return null

      const documentValidation = ProjectDocumentPlaintextSchema.safeParse(
        JSON.parse(new TextDecoder().decode(plaintextBytes)),
      )
      if (!documentValidation.success) {
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
        sizeBytes: new TextEncoder().encode(decoded.content).length,
        syncVersion: etagToSyncVersion(item.etag),
        createdAt: now,
        updatedAt: now,
        content: decoded.content,
      }
    } catch (error) {
      logError(`Failed to get document ${documentId}`, error, {
        component: 'ProjectStorage',
        action: 'getDocument',
        metadata: { projectId, documentId },
      })
      return null
    }
  }

  // Batch variant of getDocument: pulls every requested document for a
  // project in a single enclave round-trip and returns the decoded
  // ProjectDocument objects keyed by id. Missing ids are simply absent
  // from the result Map.
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
        if (!item.ok) continue
        const originalId = compositeToOriginal.get(item.id)
        if (!originalId) continue
        const plaintextBytes = pullItemPlaintext(item)
        if (!plaintextBytes) continue
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
            continue
          }
          const decoded = documentValidation.data
          const now = new Date().toISOString()
          result.set(originalId, {
            id: originalId,
            projectId,
            filename: decoded.filename || '',
            contentType: decoded.contentType || '',
            sizeBytes: new TextEncoder().encode(decoded.content).length,
            syncVersion: etagToSyncVersion(item.etag),
            createdAt: now,
            updatedAt: now,
            content: decoded.content,
          })
        } catch (decodeErr) {
          logError(`Failed to decode document ${originalId}`, decodeErr, {
            component: 'ProjectStorage',
            action: 'getDocuments',
            metadata: { projectId, documentId: originalId },
          })
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
    const documents: ProjectDocumentListResponse['documents'] = []
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: PROJECT_DOCUMENT_SCOPE,
        cursor,
        limit: 500,
      })
      documents.push(
        ...status.updates
          .filter((update) => update.id.startsWith(`${projectId}/`))
          .map(projectDocumentListItemFromStatus),
      )
      cursor = status.next_cursor
    } while (cursor)
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

  async listProjectChats(
    projectId: string,
    options?: { continuationToken?: string },
  ): Promise<ProjectChatListResponse> {
    const chats: ProjectChatListResponse['chats'] = []
    let cursor = options?.continuationToken
    let nextContinuationToken: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: CHAT_SCOPE,
        projectId,
        cursor,
        limit: ENCLAVE_PROJECT_CHAT_LIST_LIMIT,
      })
      chats.push(
        ...status.updates
          .filter((update) => update.project_id === projectId)
          .map(projectChatFromStatus),
      )
      cursor = status.next_cursor
      nextContinuationToken = status.next_cursor
    } while (
      chats.length < ENCLAVE_PROJECT_CHAT_LIST_LIMIT &&
      hasNextCursor(cursor)
    )

    return {
      chats,
      nextContinuationToken,
      hasMore: hasNextCursor(nextContinuationToken),
    }
  }

  async getProjectChatsSyncStatus(
    projectId: string,
  ): Promise<ProjectChatSyncStatus> {
    let count = 0
    let lastUpdated: string | null = null
    let cursor: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: CHAT_SCOPE,
        projectId,
        cursor,
        limit: 500,
      })
      for (const update of status.updates) {
        if (update.project_id !== projectId) continue
        count++
        if (!lastUpdated || update.updated_at > lastUpdated) {
          lastUpdated = update.updated_at
        }
      }
      cursor = status.next_cursor
    } while (cursor)

    return { count, lastUpdated }
  }

  async getProjectChatsUpdatedSince(
    projectId: string,
    options: { since: string; cursorId?: string },
  ): Promise<ProjectChatListResponse> {
    const chats: ProjectChatListResponse['chats'] = []
    let cursor: string | undefined = options.cursorId ?? options.since
    let nextContinuationToken: string | undefined
    do {
      const status = await enclaveListStatus({
        scope: CHAT_SCOPE,
        projectId,
        cursor,
        limit: ENCLAVE_PROJECT_CHAT_LIST_LIMIT,
      })
      chats.push(
        ...status.updates
          .filter(
            (update) =>
              update.project_id === projectId &&
              update.updated_at > options.since,
          )
          .map(projectChatFromStatus),
      )
      cursor = status.next_cursor
      nextContinuationToken = status.next_cursor
    } while (
      chats.length < ENCLAVE_PROJECT_CHAT_LIST_LIMIT &&
      hasNextCursor(cursor)
    )

    return {
      chats,
      nextContinuationToken,
      hasMore: hasNextCursor(nextContinuationToken),
    }
  }
}

export const projectStorage = new ProjectStorageService()
