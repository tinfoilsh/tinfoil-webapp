'use client'

import type { Fact } from '@/types/memory'
import type {
  CreateProjectData,
  Project,
  ProjectContextUsage,
  ProjectDocument,
  UpdateProjectData,
} from '@/types/project'
import { createContext, useContext } from 'react'

export interface LoadingProject {
  id: string
  name: string
}

export interface UploadingFile {
  id: string
  name: string
  size: number
}

export interface EnterProjectModeOptions {
  isCurrent?: () => boolean
}

export interface ProjectContextValue {
  activeProject: Project | null
  isProjectMode: boolean
  projectDocuments: ProjectDocument[]
  loading: boolean
  loadingProject: LoadingProject | null
  error: string | null
  uploadingFiles: UploadingFile[]

  enterProjectMode: (
    projectId: string,
    projectName?: string,
    options?: EnterProjectModeOptions,
  ) => Promise<boolean>
  exitProjectMode: () => void
  createProject: (data: CreateProjectData) => Promise<Project>
  updateProject: (id: string, data: UpdateProjectData) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  uploadDocument: (file: File, content: string) => Promise<ProjectDocument>
  removeDocument: (docId: string) => Promise<void>
  refreshDocuments: () => Promise<void>
  updateProjectMemory: (memory: Fact[]) => Promise<void>
  addUploadingFile: (file: UploadingFile) => void
  removeUploadingFile: (id: string) => void

  getContextUsage: (modelContextLimit: number) => ProjectContextUsage
}

export const ProjectContext = createContext<ProjectContextValue | null>(null)

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider')
  }
  return context
}
