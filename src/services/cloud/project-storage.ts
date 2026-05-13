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
import { encryptionService } from '../encryption/encryption-service'
import {
  pull as enclavePull,
  push as enclavePush,
  hexToB64,
  pullItemPlaintext,
  type PullKey,
} from '../sync-enclave/sync-api'
import { canWriteToCloud } from './cloud-key-authorization'

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.tinfoil.sh'

const PROJECT_SCOPE = 'project'
const PROJECT_DOCUMENT_SCOPE = 'project_document'

function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function pullKeysFromEncryptionService(): PullKey[] {
  const all = encryptionService.getAllKeys()
  const out: PullKey[] = []
  if (all.primary) out.push({ key: hexToB64(all.primary) })
  for (const alt of all.alternatives) {
    if (alt !== all.primary) out.push({ key: hexToB64(alt) })
  }
  return out
}

function requirePrimaryKeyB64(): string {
  const key = encryptionService.getKey()
  if (!key) {
    throw new Error('project-storage: no encryption key available')
  }
  return hexToB64(key)
}

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
      const keys = pullKeysFromEncryptionService()
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

      const decoded = JSON.parse(
        new TextDecoder().decode(plaintextBytes),
      ) as ProjectData

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

  async deleteProject(projectId: string): Promise<void> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const response = await fetch(
      `${API_BASE_URL}/api/storage/project/${projectId}`,
      {
        method: 'DELETE',
        headers: await this.getHeaders(),
      },
    )

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete project: ${response.statusText}`)
    }
  }

  async deleteAllProjects(): Promise<{ deleted: number }> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const response = await fetch(`${API_BASE_URL}/api/storage/projects`, {
      method: 'DELETE',
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to delete all projects: ${response.statusText}`)
    }

    return response.json()
  }

  async listProjects(options?: {
    limit?: number
    continuationToken?: string
    includeContent?: boolean
  }): Promise<ProjectListResponse> {
    const params = new URLSearchParams()
    if (options?.limit) {
      params.append('limit', options.limit.toString())
    }
    if (options?.continuationToken) {
      params.append('continuationToken', options.continuationToken)
    }
    if (options?.includeContent) {
      params.append('includeContent', 'true')
    }

    const url = `${API_BASE_URL}/api/projects${params.toString() ? `?${params.toString()}` : ''}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to list projects: ${response.statusText}`)
    }

    return response.json()
  }

  async getProjectSyncStatus(): Promise<ProjectSyncStatus> {
    const response = await fetch(`${API_BASE_URL}/api/projects/sync-status`, {
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get project sync status: ${response.statusText}`,
      )
    }

    return response.json()
  }

  async getProjectsUpdatedSince(options: {
    since: string
    continuationToken?: string
  }): Promise<ProjectListResponse> {
    const params = new URLSearchParams()
    params.append('since', options.since)
    if (options.continuationToken) {
      params.append('continuationToken', options.continuationToken)
    }

    const url = `${API_BASE_URL}/api/projects/updated-since?${params.toString()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get projects updated since: ${response.statusText}`,
      )
    }

    return response.json()
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
      const keys = pullKeysFromEncryptionService()
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

      const decoded = JSON.parse(new TextDecoder().decode(plaintextBytes)) as {
        content: string
        filename?: string
        contentType?: string
      }

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

  async deleteDocument(projectId: string, documentId: string): Promise<void> {
    if (!(await canWriteToCloud())) {
      throw new Error(
        'Cloud writes are blocked until your encryption key is verified',
      )
    }

    const response = await fetch(
      `${API_BASE_URL}/api/projects/${projectId}/documents/${documentId}`,
      {
        method: 'DELETE',
        headers: await this.getHeaders(),
      },
    )

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete document: ${response.statusText}`)
    }
  }

  async listDocuments(
    projectId: string,
    options?: { includeContent?: boolean },
  ): Promise<ProjectDocumentListResponse> {
    const params = new URLSearchParams()
    if (options?.includeContent) {
      params.append('includeContent', 'true')
    }

    const url = `${API_BASE_URL}/api/projects/${projectId}/documents${params.toString() ? `?${params.toString()}` : ''}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to list documents: ${response.statusText}`)
    }

    return response.json()
  }

  async getDocumentSyncStatus(
    projectId: string,
  ): Promise<ProjectDocumentSyncStatus> {
    const response = await fetch(
      `${API_BASE_URL}/api/projects/${projectId}/documents/sync-status`,
      {
        headers: await this.getHeaders(),
      },
    )

    if (!response.ok) {
      throw new Error(
        `Failed to get document sync status: ${response.statusText}`,
      )
    }

    return response.json()
  }

  async listProjectChats(
    projectId: string,
    options?: { includeContent?: boolean; continuationToken?: string },
  ): Promise<ProjectChatListResponse> {
    const params = new URLSearchParams()
    if (options?.includeContent) {
      params.append('includeContent', 'true')
    }
    if (options?.continuationToken) {
      params.append('continuationToken', options.continuationToken)
    }

    const url = `${API_BASE_URL}/api/projects/${projectId}/chats${params.toString() ? `?${params.toString()}` : ''}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
    })

    if (!response.ok) {
      throw new Error(`Failed to list project chats: ${response.statusText}`)
    }

    return response.json()
  }

  async getProjectChatsSyncStatus(
    projectId: string,
  ): Promise<ProjectChatSyncStatus> {
    const url = `${API_BASE_URL}/api/projects/${projectId}/chats/sync-status?_t=${Date.now()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get project chats sync status: ${response.statusText}`,
      )
    }

    return response.json()
  }

  async getProjectChatsUpdatedSince(
    projectId: string,
    options: { since: string; cursorId?: string },
  ): Promise<ProjectChatListResponse> {
    const params = new URLSearchParams()
    params.append('since', options.since)
    if (options.cursorId) {
      params.append('continuationToken', options.cursorId)
    }
    params.append('_t', Date.now().toString())

    const url = `${API_BASE_URL}/api/projects/${projectId}/chats/updated-since?${params.toString()}`
    const response = await fetch(url, {
      headers: await this.getHeaders(),
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to get project chats updated since: ${response.statusText}`,
      )
    }

    return response.json()
  }
}

export const projectStorage = new ProjectStorageService()
