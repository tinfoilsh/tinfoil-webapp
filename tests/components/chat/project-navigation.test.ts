import { openProjectChat } from '@/components/chat/project-navigation'
import { describe, expect, it, vi } from 'vitest'

describe('openProjectChat', () => {
  it.each([true, false, new Error('Project unavailable')])(
    'creates a fresh chat before entering a project and forwards %s',
    async (result) => {
      const calls: string[] = []
      const createNewChat = vi.fn(
        (_isLocalOnly?: boolean, _fromUserAction?: boolean) => {
          calls.push('create')
        },
      )
      const enterProjectMode = vi.fn(
        async (_projectId: string, _projectName?: string) => {
          calls.push('enter')
          if (result instanceof Error) throw result
          return result
        },
      )
      const pending = openProjectChat({
        projectId: 'new-project',
        projectName: 'New project',
        createNewChat,
        enterProjectMode,
      })
      if (result instanceof Error) await expect(pending).rejects.toBe(result)
      else await expect(pending).resolves.toBe(result)
      expect(calls).toEqual(['create', 'enter'])
      expect(createNewChat).toHaveBeenCalledExactlyOnceWith(false, true)
      expect(enterProjectMode).toHaveBeenCalledExactlyOnceWith(
        'new-project',
        'New project',
      )
    },
  )
})
