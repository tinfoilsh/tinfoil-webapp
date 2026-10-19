'use client'

import type { Fact } from '@/types/memory'
import type {
  CreateProjectData,
  Project,
  ProjectContextUsage,
  ProjectDocument,
  UpdateProjectData,
} from '@/types/project'
import { escapePromptContent } from '@/utils/prompt-escaping'
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
  uploadDocument: (
    file: File,
    content: string,
    thumbnailBase64?: string,
  ) => Promise<ProjectDocument>
  removeDocument: (docId: string) => Promise<void>
  refreshDocuments: () => Promise<void>
  updateProjectMemory: (memory: Fact[]) => Promise<void>
  addUploadingFile: (file: UploadingFile) => void
  removeUploadingFile: (id: string) => void

  getProjectSystemPrompt: () => string
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

export function estimateTokenCount(text: string | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function buildProjectContext(
  project: Project,
  documents: ProjectDocument[],
): string {
  let context = `## Project: ${escapePromptContent(project.name)}\n`

  if (project.description) {
    context += `\n${escapePromptContent(project.description)}\n`
  }

  if (project.systemInstructions) {
    context += `\n### Instructions\n${escapePromptContent(project.systemInstructions)}\n`
  }

  if (documents.length > 0) {
    context += `\n### Documents\n`
    for (const doc of documents) {
      if (doc.content) {
        context += `--- ${escapePromptContent(doc.filename)} ---\n${escapePromptContent(doc.content)}\n\n`
      }
    }
  }

  // Project memory is currently disabled - uncomment to re-enable
  // if (project.memory && project.memory.length > 0) {
  //   context += `\n### User Memory (from previous conversations)\n`
  //   context += formatMemoryFacts(project.memory)
  // }

  return context
}

function formatMemoryFacts(facts: Fact[]): string {
  const byCategory = facts.reduce(
    (acc, fact) => {
      if (!acc[fact.category]) acc[fact.category] = []
      acc[fact.category].push(fact)
      return acc
    },
    {} as Record<string, Fact[]>,
  )

  let output = ''
  for (const [category, categoryFacts] of Object.entries(byCategory)) {
    output += `**${category}**\n`
    for (const fact of categoryFacts) {
      output += `- ${fact.fact}\n`
    }
    output += '\n'
  }
  return output.trim()
}
