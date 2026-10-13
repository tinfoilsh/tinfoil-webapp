import { DragProvider } from '@/components/chat/drag-context'
import { ProjectSidebar } from '@/components/project/project-sidebar'
import type { Project, ProjectDocument } from '@/types/project'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const projectContext = vi.hoisted(() => ({
  projectDocuments: [] as ProjectDocument[],
  uploadingFiles: [],
  loading: false,
  uploadDocument: vi.fn(),
  removeDocument: vi.fn(),
  updateProject: vi.fn(),
  updateProjectMemory: vi.fn(),
  deleteProject: vi.fn(),
  refreshDocuments: vi.fn(),
  addUploadingFile: vi.fn(),
  removeUploadingFile: vi.fn(),
}))
vi.mock('@/components/project/project-context', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/project/project-context')
  >()),
  useProject: () => projectContext,
}))
vi.mock('@/components/chat/document-uploader', () => ({
  useDocumentUploader: () => ({
    handleDocumentUpload: vi.fn(),
    isDocumentUploading: false,
  }),
}))
vi.mock('@clerk/react', () => ({
  useAuth: () => ({
    isSignedIn: true,
    getToken: async () => null,
    userId: 'test-user',
  }),
  useUser: () => ({ user: null, isLoaded: true }),
}))
vi.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/project/test-project' }),
}))
vi.mock('@/hooks/use-rate-limit', () => ({ useRateLimit: () => null }))
vi.mock('@/hooks/use-safeguards', () => ({ useFlaggedChatIds: () => ({}) }))

// The context budget is 80% of the window: 8k tokens of a 10k window.
const CONTEXT_WINDOW_TOKENS = 10_000
const WARNING_TEXT =
  'This project needs about 9k tokens of context, but the selected model can fit about 8k. Replies here may fail. Remove some documents or split them across projects.'

const project: Project = {
  id: 'test-project',
  name: 'Estate',
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  syncVersion: 1,
}

// Content estimated at `tokens` tokens (four characters per token).
function documentWithTokens(id: string, tokens: number): ProjectDocument {
  const content = 'a'.repeat(tokens * 4)
  return {
    id,
    projectId: project.id,
    filename: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: content.length,
    syncVersion: 1,
    createdAt: '2026-09-01T12:00:00Z',
    updatedAt: '2026-09-01T12:00:00Z',
    content,
  }
}

function renderSidebar(contextWindowTokens?: number) {
  render(
    <DragProvider>
      <ProjectSidebar
        isOpen
        setIsOpen={vi.fn()}
        isDarkMode={false}
        isClient
        pixelateSidebarChatTitles={false}
        cloudSyncEnabled
        isPremium
        windowWidth={1200}
        project={project}
        onExitProject={vi.fn()}
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        contextWindowTokens={contextWindowTokens}
      />
    </DragProvider>,
  )
}

function expandDocuments(count: number) {
  const header = screen.getByRole('button', {
    name: new RegExp(`^Documents \\(${count}\\)`),
  })
  fireEvent.click(header)
  return header
}

describe('project sidebar context warning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    projectContext.projectDocuments = []
  })

  it('warns when the project needs more than the model budget but less than its window', () => {
    projectContext.projectDocuments = [
      documentWithTokens('letter', 4_500),
      documentWithTokens('statement', 4_500),
    ]
    renderSidebar(CONTEXT_WINDOW_TOKENS)

    const header = expandDocuments(2)

    expect(header).toHaveAccessibleName(
      'Documents (2) Too large for the selected model',
    )
    expect(screen.getByText(WARNING_TEXT)).toHaveAttribute('role', 'status')
  })

  it('stays quiet when the project fits the model budget', () => {
    projectContext.projectDocuments = [documentWithTokens('letter', 7_000)]
    renderSidebar(CONTEXT_WINDOW_TOKENS)

    const header = expandDocuments(1)

    expect(header).toHaveAccessibleName('Documents (1)')
    expect(screen.queryByText(/tokens of context/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Upload documents' }),
    ).toBeInTheDocument()
  })

  it('waits for the model context window before warning', () => {
    projectContext.projectDocuments = [
      documentWithTokens('letter', 4_500),
      documentWithTokens('statement', 4_500),
    ]
    renderSidebar(undefined)

    const header = expandDocuments(2)

    expect(header).toHaveAccessibleName('Documents (2)')
    expect(screen.queryByText(/tokens of context/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Upload documents' }),
    ).toBeInTheDocument()
  })
})
