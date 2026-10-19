import type { ProjectStorageService } from '@/services/cloud/project-storage'
import type {
  ProjectDocumentListItem,
  ProjectListResponse,
} from '@/types/project'
import type { ClaudeProject } from '@/utils/chat-import-parsers'

export const CLAUDE_PROJECT_EXPORT_MAX_BYTES = 64 * 1024 * 1024

const PROJECT_PAGE_LIMIT = 100
const DOCUMENT_READ_CONCURRENCY = 4

type ProjectListItem = ProjectListResponse['projects'][number]

export interface ClaudeProjectExportCounts {
  exportedProjects: number
  skippedProjects: number
  exportedDocuments: number
  skippedDocuments: number
  failedDocumentListings: number
}

export interface ClaudeProjectExportResult {
  json: string
  counts: ClaudeProjectExportCounts
  warnings: string[]
}

export class ClaudeProjectExportSizeError extends Error {
  constructor() {
    super('The Claude-compatible project export exceeds the 64 MiB limit.')
    this.name = 'ClaudeProjectExportSizeError'
  }
}

export function formatClaudeProjectExportCounts(
  counts: ClaudeProjectExportCounts,
): string {
  const count = (value: number, noun: string) =>
    `${value} ${noun}${value === 1 ? '' : 's'}`
  const exported = `Exported ${count(counts.exportedProjects, 'project')} and ${count(counts.exportedDocuments, 'document')}.`
  if (counts.failedDocumentListings === 0) {
    return `${exported} Skipped ${count(counts.skippedProjects, 'project')} and ${count(counts.skippedDocuments, 'document')}.`
  }

  const failedListings = count(counts.failedDocumentListings, 'project')
  const knownSkippedDocuments =
    counts.skippedDocuments > 0
      ? ` Of the documents that were listed, ${count(counts.skippedDocuments, 'document')} ${counts.skippedDocuments === 1 ? 'was' : 'were'} skipped.`
      : ''
  return `${exported} Skipped ${count(counts.skippedProjects, 'project')}. The skipped document total is unknown because document listing failed for ${failedListings}.${knownSkippedDocuments}`
}

interface ExportOptions {
  maxEncodedBytes?: number
}

async function listAllProjects(
  storage: Pick<ProjectStorageService, 'listProjects'>,
): Promise<ProjectListItem[]> {
  const projectsById = new Map<string, ProjectListItem>()
  let continuationToken: string | undefined

  do {
    const page = await storage.listProjects({
      limit: PROJECT_PAGE_LIMIT,
      continuationToken,
    })
    for (const project of page.projects) {
      const existing = projectsById.get(project.id)
      if (
        !existing ||
        project.updatedAt > existing.updatedAt ||
        (project.updatedAt === existing.updatedAt &&
          project.syncVersion > existing.syncVersion)
      ) {
        projectsById.set(project.id, project)
      }
    }
    continuationToken = page.nextContinuationToken
  } while (continuationToken)

  return [...projectsById.values()].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    if (a.syncVersion !== b.syncVersion) return b.syncVersion - a.syncVersion
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

class ExportSizeGuard {
  private readonly encoder = new TextEncoder()
  private completedProjectBytes = 0
  private completedProjects = 0
  private pendingProjectBytes = 0
  private pendingDocuments = 0

  constructor(private readonly maxEncodedBytes: number) {}

  beginProject(project: ClaudeProject): void {
    this.pendingProjectBytes = this.encodedLength(this.indent(project, 2))
    this.pendingDocuments = 0
    this.assertWithinBound(this.pendingProjectBytes)
  }

  addDocument(document: NonNullable<ClaudeProject['docs']>[number]): void {
    const documentBytes = this.encodedLength(this.indent(document, 6))
    if (this.pendingDocuments === 0) {
      const projectClosingBytes = this.encodedLength('\n  }')
      this.pendingProjectBytes +=
        this.encodedLength(',\n    "docs": [\n') +
        documentBytes +
        this.encodedLength('\n    ]\n  }') -
        projectClosingBytes
    } else {
      this.pendingProjectBytes += this.encodedLength(',\n') + documentBytes
    }
    this.pendingDocuments++
    this.assertWithinBound(this.pendingProjectBytes)
  }

  finishProject(project: ClaudeProject): string {
    const serialized = this.indent(project, 2)
    const serializedBytes = this.encodedLength(serialized)
    this.assertWithinBound(serializedBytes)
    this.completedProjectBytes += serializedBytes
    this.completedProjects++
    this.pendingProjectBytes = 0
    this.pendingDocuments = 0
    return serialized
  }

  encodedLength(value: string): number {
    return this.encoder.encode(value).length
  }

  assertFinal(encodedBytes: number): void {
    if (encodedBytes > this.maxEncodedBytes) {
      throw new ClaudeProjectExportSizeError()
    }
  }

  private indent(value: unknown, spaces: number): string {
    const indentation = ' '.repeat(spaces)
    return JSON.stringify(value, null, 2)
      .split('\n')
      .map((line) => `${indentation}${line}`)
      .join('\n')
  }

  private assertWithinBound(pendingProjectBytes: number): void {
    const framingBytes = 4
    const separatorBytes = this.completedProjects > 0 ? 2 : 0
    const completedSeparatorBytes = Math.max(0, this.completedProjects - 1) * 2
    if (
      framingBytes +
        this.completedProjectBytes +
        completedSeparatorBytes +
        separatorBytes +
        pendingProjectBytes >
      this.maxEncodedBytes
    ) {
      throw new ClaudeProjectExportSizeError()
    }
  }
}

async function readDocuments(
  storage: Pick<ProjectStorageService, 'getDocument'>,
  projectId: string,
  documents: ProjectDocumentListItem[],
  counts: ClaudeProjectExportCounts,
  warnings: string[],
  sizeGuard: ExportSizeGuard,
): Promise<NonNullable<ClaudeProject['docs']>> {
  const exported: Array<NonNullable<ClaudeProject['docs']>[number] | null> =
    new Array(documents.length).fill(null)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < documents.length) {
      const index = nextIndex++
      const listedDocument = documents[index]
      try {
        const document = await storage.getDocument(projectId, listedDocument.id)
        if (
          !document ||
          document.decryptionFailed ||
          document.content == null
        ) {
          counts.skippedDocuments++
          warnings.push(
            `Skipped document ${listedDocument.id} in project ${projectId}.`,
          )
          continue
        }
        const exportedDocument = {
          uuid: listedDocument.id,
          filename: document.filename,
          content: document.content,
          created_at: listedDocument.createdAt,
        }
        sizeGuard.addDocument(exportedDocument)
        exported[index] = exportedDocument
        counts.exportedDocuments++
      } catch (error) {
        if (error instanceof ClaudeProjectExportSizeError) throw error
        counts.skippedDocuments++
        warnings.push(
          `Skipped document ${listedDocument.id} in project ${projectId}.`,
        )
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DOCUMENT_READ_CONCURRENCY, documents.length) },
      worker,
    ),
  )
  return exported.filter(
    (document): document is NonNullable<typeof document> => document !== null,
  )
}

export async function buildClaudeProjectExport(
  storage: Pick<
    ProjectStorageService,
    'listProjects' | 'getProject' | 'listDocuments' | 'getDocument'
  >,
  options: ExportOptions = {},
): Promise<ClaudeProjectExportResult> {
  // Finish the authoritative project listing before reading any content. A
  // listing failure must abort rather than produce an incomplete project set.
  const listedProjects = await listAllProjects(storage)
  const serializedProjects: string[] = []
  const sizeGuard = new ExportSizeGuard(
    options.maxEncodedBytes ?? CLAUDE_PROJECT_EXPORT_MAX_BYTES,
  )
  const counts: ClaudeProjectExportCounts = {
    exportedProjects: 0,
    skippedProjects: 0,
    exportedDocuments: 0,
    skippedDocuments: 0,
    failedDocumentListings: 0,
  }
  const warnings: string[] = []

  for (const listedProject of listedProjects) {
    let project
    try {
      project = await storage.getProject(listedProject.id)
    } catch {
      project = null
    }
    if (!project || project.decryptionFailed) {
      counts.skippedProjects++
      warnings.push(`Skipped project ${listedProject.id}.`)
      continue
    }

    const exportedProject: ClaudeProject = {
      uuid: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      ...(project.systemInstructions
        ? { prompt_template: project.systemInstructions }
        : {}),
      created_at: listedProject.createdAt,
      updated_at: listedProject.updatedAt,
    }
    sizeGuard.beginProject(exportedProject)

    let listedDocuments: ProjectDocumentListItem[] = []
    try {
      listedDocuments = (await storage.listDocuments(project.id)).documents
    } catch {
      counts.failedDocumentListings++
      warnings.push(
        `Documents for project ${project.id} could not be listed, so their skipped count is unknown.`,
      )
    }
    const docs = await readDocuments(
      storage,
      project.id,
      listedDocuments,
      counts,
      warnings,
      sizeGuard,
    )

    if (docs.length > 0) exportedProject.docs = docs
    serializedProjects.push(sizeGuard.finishProject(exportedProject))
    counts.exportedProjects++
  }

  const json =
    serializedProjects.length === 0
      ? '[]'
      : `[\n${serializedProjects.join(',\n')}\n]`
  sizeGuard.assertFinal(sizeGuard.encodedLength(json))

  return { json, counts, warnings }
}
