/**
 * Project types for the Projects feature
 * Projects are containers with custom system instructions, documents, and project-specific chats
 */

export interface Project {
  id: string
  name: string
  description: string
  systemInstructions: string
  color?: string
  createdAt: string
  updatedAt: string
  decryptionFailed?: boolean
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
  decryptionFailed?: boolean
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
