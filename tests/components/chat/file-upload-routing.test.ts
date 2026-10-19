import {
  resolveProjectUploadTarget,
  routeChatFileUpload,
} from '@/components/chat/file-upload-routing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('routeChatFileUpload', () => {
  const file = new File(['content'], 'notes.txt', { type: 'text/plain' })

  beforeEach(() => {
    localStorage.clear()
  })

  it('asks for a destination when a project is active', async () => {
    const requestDestination = vi.fn()
    const processFileForChat = vi.fn().mockResolvedValue(undefined)
    const projectTarget = { projectId: 'project_123', isReady: true }

    localStorage.setItem('projectUploadPreference', 'project')
    localStorage.setItem('tinfoil-user-prefs-project-upload', 'project')

    await routeChatFileUpload(file, {
      projectTarget,
      requestDestination,
      processFileForChat,
    })

    expect(requestDestination).toHaveBeenCalledWith(file, projectTarget)
    expect(processFileForChat).not.toHaveBeenCalled()
  })

  it('queues the destination request while a project is loading', async () => {
    const requestDestination = vi.fn()
    const processFileForChat = vi.fn().mockResolvedValue(undefined)
    const projectTarget = { projectId: 'project_123', isReady: false }

    await routeChatFileUpload(file, {
      projectTarget,
      requestDestination,
      processFileForChat,
    })

    expect(requestDestination).toHaveBeenCalledWith(file, projectTarget)
    expect(processFileForChat).not.toHaveBeenCalled()
  })

  it('uploads directly to chat outside project mode', async () => {
    const requestDestination = vi.fn()
    const processFileForChat = vi.fn().mockResolvedValue(undefined)

    await routeChatFileUpload(file, {
      projectTarget: null,
      requestDestination,
      processFileForChat,
    })

    expect(processFileForChat).toHaveBeenCalledWith(file)
    expect(requestDestination).not.toHaveBeenCalled()
  })
})

describe('resolveProjectUploadTarget', () => {
  it('queues files for the project being loaded instead of the old active project', () => {
    expect(
      resolveProjectUploadTarget({
        activeProjectId: 'project_old',
        loadingProjectId: 'project_new',
      }),
    ).toEqual({ projectId: 'project_new', isReady: false })
  })

  it('queues files until the loading project becomes active', () => {
    expect(
      resolveProjectUploadTarget({
        loadingProjectId: 'project_123',
      }),
    ).toEqual({ projectId: 'project_123', isReady: false })
  })

  it('does not target a project after project mode exits', () => {
    expect(resolveProjectUploadTarget({})).toBeNull()
  })
})
