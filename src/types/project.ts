/**
 * Project types for the Projects feature
 * Projects are containers with custom system instructions, documents, and project-specific chats
 */
import type { StoredProjectDocument } from '@/services/harness/types'

export interface Project {
  id: string
  name: string
  description: string
  systemInstructions: string
  color?: string
  createdAt: string
  updatedAt: string
}

export interface ProjectDocument {
  id: string
  projectId: string
  filename: string
  contentType: string
  sizeBytes: number
  createdAt: string
  updatedAt: string
  content?: string
  // Small JPEG preview stored alongside image documents so the sidebar can
  // show a real thumbnail; the full image is never persisted.
  thumbnailBase64?: string
  // Whether the uploaded file is kept, to download as it was uploaded. A
  // document stored before files were kept has only its text.
  hasFile?: StoredProjectDocument['hasFile']
}

export interface CreateProjectData {
  name: string
  description?: string
  systemInstructions?: string
  color?: string
}

export interface UpdateProjectData {
  name?: string
  description?: string
  systemInstructions?: string
  color?: string
}
