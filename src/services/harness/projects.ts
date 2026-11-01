import type {
  CreateProjectData,
  Project,
  ProjectDocument,
  UpdateProjectData,
} from '@/types/project'
import { ROUTES } from './protocol'
import type { HarnessAPI } from './runtime'

// The account's projects, which the harness stores with its chats.

export interface ProjectPage {
  projects: Project[]
  nextCursor: string | null
}

export const listProjects = (api: HarnessAPI, cursor: string | null) =>
  api.post<ProjectPage>(ROUTES.projectsList, { cursor })

// A project with its documents.
export const getProject = (api: HarnessAPI, id: string) =>
  api.post<Project & { documents: ProjectDocument[] }>(ROUTES.projectsGet, {
    id,
  })

export const createProject = (api: HarnessAPI, data: CreateProjectData) =>
  api.post<Project>(ROUTES.projectsCreate, data)

export const updateProject = (
  api: HarnessAPI,
  id: string,
  data: UpdateProjectData,
) => api.post(ROUTES.projectsUpdate, { id, ...data })

export const deleteProject = (api: HarnessAPI, id: string) =>
  api.post(ROUTES.projectsDelete, { id })

export const deleteAllProjects = (api: HarnessAPI) =>
  api.post<{ deleted: number }>(ROUTES.projectsDeleteAll)

export const uploadProjectDocument = (
  api: HarnessAPI,
  projectId: string,
  file: File,
) =>
  api.upload<ProjectDocument>(ROUTES.projectDocumentUpload, file, {
    projectId,
  })

export const deleteProjectDocument = (
  api: HarnessAPI,
  projectId: string,
  documentId: string,
) => api.post(ROUTES.projectDocumentDelete, { projectId, documentId })
