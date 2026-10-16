import { openProjectChat } from '@/components/chat/project-navigation'
import { describe, expect, it, vi } from 'vitest'

describe('openProjectChat', () => {
  it('creates a fresh chat before entering a project', async () => {
    const calls: string[] = []
    const createNewChat = vi.fn(
      (_isLocalOnly?: boolean, _fromUserAction?: boolean) => {
        calls.push('create')
      },
    )
    const enterProjectMode = vi.fn(
      async (_projectId: string, _projectName?: string) => {
        calls.push('enter')
        return true
      },
    )
    await openProjectChat({
      projectId: 'new-project',
      projectName: 'New project',
      createNewChat,
      enterProjectMode,
    })
    expect(calls).toEqual(['create', 'enter'])
    expect(createNewChat).toHaveBeenCalledExactlyOnceWith(false, true)
    expect(enterProjectMode).toHaveBeenCalledExactlyOnceWith(
      'new-project',
      'New project',
    )
  })
})
