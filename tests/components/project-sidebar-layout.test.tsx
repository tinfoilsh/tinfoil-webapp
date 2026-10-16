import { DragProvider } from '@/components/chat/drag-context'
import { ProjectSidebar } from '@/components/project/project-sidebar'
import type { Project } from '@/types/project'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const projectContext = vi.hoisted(() => ({
  projectDocuments: [],
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
vi.mock('@/components/project/project-context', () => ({
  useProject: () => projectContext,
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

const project: Project = {
  id: 'test-project',
  name: 'Research',
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  syncVersion: 1,
}

function renderSidebar(
  overrides: Partial<Parameters<typeof ProjectSidebar>[0]> = {},
) {
  render(
    <DragProvider>
      <ProjectSidebar
        isOpen
        setIsOpen={vi.fn()}
        isDarkMode={false}
        isClient
        pixelateSidebarChatTitles={false}
        cloudSyncEnabled
        windowWidth={1200}
        project={project}
        onExitProject={vi.fn()}
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        {...overrides}
      />
    </DragProvider>,
  )
}

describe('project sidebar layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  it('orders project chats by update time with creation time as the fallback', () => {
    const chats = [
      {
        id: 'old',
        title: 'Older chat',
        messageCount: 2,
        createdAt: new Date('2026-09-01T12:00:00Z'),
      },
      {
        id: 'updated',
        title: 'Recently updated',
        messageCount: 2,
        createdAt: new Date('2026-09-01T12:00:00Z'),
        updatedAt: '2026-09-03T12:00:00Z',
      },
      {
        id: 'created',
        title: 'Recently created',
        messageCount: 2,
        createdAt: new Date('2026-09-02T12:00:00Z'),
      },
    ]
    renderSidebar({ chats, pixelateSidebarChatTitles: false })
    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent),
    ).toEqual(['Recently updated', 'Recently created', 'Older chat'])
    expect(chats.map((chat) => chat.id)).toEqual(['old', 'updated', 'created'])
  })
})
