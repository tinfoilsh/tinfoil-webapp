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

// Adds a document to a project. With `documentId`, the upload replaces that
// document as a new version of it. The harness reads both ids before the
// file, which a form sends after its fields.
export const uploadProjectDocument = (
  api: HarnessAPI,
  projectId: string,
  file: File,
  documentId?: string,
) =>
  api.upload<ProjectDocument>(ROUTES.projectDocumentUpload, file, {
    projectId,
    ...(documentId ? { documentId } : {}),
  })

const MARKDOWN_EXTENSION = '.md'
// The names whose documents are text already, and the type each saves as.
const TEXT_FILE_TYPES: Record<string, string> = {
  [MARKDOWN_EXTENSION]: 'text/markdown;charset=utf-8',
  '.txt': 'text/plain;charset=utf-8',
}

// A document as a file to save: the file it was uploaded as, named and typed
// from the document. A document without one has only the text read from it,
// which saves as Markdown unless its name says it is text already.
export async function projectDocumentFile(
  api: HarnessAPI,
  document: ProjectDocument,
): Promise<File> {
  if (document.hasFile) {
    const uploaded = await api.download(ROUTES.projectDocumentDownload, {
      projectId: document.projectId,
      documentId: document.id,
    })
    return new File([uploaded], document.filename, {
      type: document.contentType,
    })
  }
  const name = document.filename.toLowerCase()
  const extension = Object.keys(TEXT_FILE_TYPES).find((known) =>
    name.endsWith(known),
  )
  return new File(
    [document.content ?? ''],
    extension ? document.filename : document.filename + MARKDOWN_EXTENSION,
    { type: TEXT_FILE_TYPES[extension ?? MARKDOWN_EXTENSION] },
  )
}

export const deleteProjectDocument = (
  api: HarnessAPI,
  projectId: string,
  documentId: string,
) => api.post(ROUTES.projectDocumentDelete, { projectId, documentId })
