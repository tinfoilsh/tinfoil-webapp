import { DragProvider } from '@/components/chat/drag-context'
import { useProject } from '@/components/project/project-context'
import { ProjectProvider } from '@/components/project/project-provider'
import { ProjectSidebar } from '@/components/project/project-sidebar'
import type { Project, ProjectDocument } from '@/types/project'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { setupHarness } from '../../harness-fixture'

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: true }),
}))
vi.mock('framer-motion', () => import('../../mocks/motion'))

const project: Project = {
  id: 'project-1',
  name: 'Research',
  description: '',
  systemInstructions: '',
  memory: [],
  createdAt: '2026-09-14T10:00:00Z',
  updatedAt: '2026-09-14T10:00:00Z',
  syncVersion: 1,
}
const document: ProjectDocument = {
  id: 'document-1',
  projectId: project.id,
  filename: 'notes.txt',
  contentType: 'text/plain',
  sizeBytes: 5,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  syncVersion: 1,
}

function Sidebar() {
  const { activeProject, loading, exitProjectMode } = useProject()
  const [isOpen, setIsOpen] = useState(true)
  return (
    <ProjectSidebar
      project={activeProject}
      isLoading={loading}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      isDarkMode={false}
      pixelateSidebarChatTitles={false}
      onExitProject={exitProjectMode}
      onNewChat={vi.fn()}
      onSelectChat={vi.fn()}
      isClient
      cloudSyncEnabled
      windowWidth={1280}
    />
  )
}

it('loads project documents once and refreshes them after uploads and deletions', async () => {
  const { client, release } = setupHarness()
  let documents = [document]
  const uploaded = { ...document, id: 'document-2', filename: 'new.txt' }
  client.post.mockImplementation(async (path, body) => {
    if (path === '/v1/projects/documents/delete') {
      documents = documents.filter((doc) => doc.id !== body.documentId)
      return {}
    }
    expect(path).toBe('/v1/projects/get')
    expect(body).toEqual({ id: project.id })
    return structuredClone({
      ...project,
      documents,
      contextUsage: {
        systemInstructions: 0,
        documents: [],
        memory: 0,
        totalUsed: 0,
        modelLimit: 1000,
        availableForChat: 1000,
      },
    })
  })
  client.upload.mockImplementation(async () => {
    documents = [...documents, uploaded]
    return uploaded
  })
  const loads = () =>
    client.post.mock.calls.filter(([path]) => path === '/v1/projects/get')

  const view = render(
    <DragProvider>
      <ProjectProvider initialProjectId={project.id}>
        <Sidebar />
      </ProjectProvider>
    </DragProvider>,
  )
  try {
    const documentsButton = await screen.findByRole('button', {
      name: 'Documents (1)',
    })
    fireEvent.click(documentsButton)
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()
    expect(loads()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(loads()).toHaveLength(1)

    const file = new File(['new'], 'new.txt', { type: 'text/plain' })
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    expect(
      await screen.findByRole('button', { name: 'Remove new.txt' }),
    ).toBeEnabled()
    expect(client.upload).toHaveBeenCalledWith(
      '/v1/projects/documents/upload',
      file,
      { projectId: project.id },
      expect.any(AbortSignal),
    )
    expect(loads()).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }))
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull())
    expect(screen.getByText('new.txt')).toBeInTheDocument()
    expect(loads()).toHaveLength(3)
  } finally {
    view.unmount()
    release()
  }
})
