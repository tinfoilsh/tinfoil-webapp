import { DragProvider } from '@/components/chat/drag-context'
import { ProjectSidebar } from '@/components/project/project-sidebar'
import type { Project } from '@/types/project'
import { fireEvent, render, screen } from '@testing-library/react'
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
vi.mock('@/components/chat/document-uploader', () => ({
  useDocumentUploader: () => ({
    handleDocumentUpload: vi.fn(),
    isDocumentUploading: false,
  }),
}))
vi.mock('@clerk/nextjs', () => ({
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
  const onExitProject = vi.fn()
  render(
    <DragProvider>
      <ProjectSidebar
        isOpen
        setIsOpen={vi.fn()}
        isDarkMode={false}
        cloudSyncEnabled
        isPremium
        windowWidth={1200}
        project={project}
        onExitProject={onExitProject}
        onProjectUpdated={vi.fn()}
        onProjectDeleted={vi.fn()}
        onSelectChat={vi.fn()}
        onNewChat={vi.fn()}
        {...overrides}
      />
    </DragProvider>,
  )
  return { onExitProject }
}

describe('project sidebar layout', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('renders rounded section headers and gray panels with square bottoms', () => {
    renderSidebar()
    for (const name of ['Favorites', 'Project Settings', 'Documents (0)']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('rounded-lg', 'mx-2')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
      expect(button).toHaveClass('border-border-subtle')
      const panel = button.parentElement!.querySelector(
        '.bg-surface-sidebar-panel',
      )
      expect(panel).toHaveClass('rounded-t-lg')
      expect(panel).not.toHaveClass('rounded-b-lg', 'rounded-lg')
    }
  })

  it('keeps the project chat description outside the inner chat scroller', () => {
    renderSidebar()
    const description = screen.getByText(
      'Chats in this project share context and documents.',
    )
    expect(description).toHaveClass('border-b', 'flex-none')
    expect(description.parentElement).toHaveClass(
      'rounded-t-lg',
      'bg-surface-sidebar-panel',
    )
    expect(description.nextElementSibling).toHaveClass(
      'overflow-y-auto',
      'overscroll-contain',
    )
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

  it('uses a compact content-width blue exit button and preserves its action', () => {
    const { onExitProject } = renderSidebar()
    const exit = screen.getByRole('button', {
      name: 'Exit Project',
    })
    expect(exit).toHaveClass('inline-flex', 'bg-tinfoil-accent-blue', 'py-1.5')
    expect(exit).not.toHaveClass('w-full')
    fireEvent.click(exit)
    expect(onExitProject).toHaveBeenCalledTimes(1)
  })
})
