import {
  getChatPath,
  getNewChatPath,
  isLocalNewChatStorage,
  isPlainPrimaryClick,
} from '@/utils/navigation'
import { describe, expect, it } from 'vitest'

describe('navigation utilities', () => {
  it('builds chat destinations for each storage context', () => {
    expect(getChatPath('chat-1')).toBe('/chat/chat-1')
    expect(getChatPath('chat-1', { isLocalOnly: true })).toBe(
      '/chat/local/chat-1',
    )
    expect(getChatPath('chat-1', { projectId: 'project-1' })).toBe(
      '/project/project-1/chat/chat-1',
    )
    expect(getNewChatPath()).toBe('/newchat')
    expect(getNewChatPath({ isLocalOnly: true })).toBe('/newchat?storage=local')
    expect(getNewChatPath({ projectId: 'project-1' })).toBe(
      '/project/project-1',
    )
  })

  it('recognizes local new-chat destinations', () => {
    expect(isLocalNewChatStorage('local')).toBe(true)
    expect(isLocalNewChatStorage('cloud')).toBe(false)
    expect(isLocalNewChatStorage(['local'])).toBe(false)
    expect(isLocalNewChatStorage(undefined)).toBe(false)
  })

  it('only classifies unmodified primary clicks as in-place navigation', () => {
    const primaryClick = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }

    expect(isPlainPrimaryClick(primaryClick)).toBe(true)
    expect(isPlainPrimaryClick({ ...primaryClick, button: 1 })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, ctrlKey: true })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, metaKey: true })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, shiftKey: true })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, altKey: true })).toBe(false)
  })
})
