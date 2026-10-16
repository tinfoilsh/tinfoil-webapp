import {
  countExcludedProjectChats,
  filterExportableChats,
} from '@/components/chat/settings-project-policy'
import type { Chat } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

const regularChat = {
  id: 'chat-1',
  title: 'Regular',
  messages: [{ role: 'user', content: 'Hello' }],
} as Chat
const projectChat = {
  ...regularChat,
  id: 'chat-2',
  title: 'Project',
  projectId: 'project-1',
} as Chat

describe('settings project policy', () => {
  it('excludes project chats from free-user exports without deleting them', () => {
    const chats = [regularChat, projectChat]

    expect(filterExportableChats(chats, false)).toEqual([regularChat])
    expect(chats).toEqual([regularChat, projectChat])
    expect(filterExportableChats(chats, true)).toEqual(chats)
    expect(countExcludedProjectChats(chats, false)).toBe(1)
    expect(countExcludedProjectChats(chats, true)).toBe(0)
  })

  it('uses loaded messages instead of stale message counts for exports', () => {
    const staleEmptyChat = {
      ...regularChat,
      id: 'chat-empty',
      messages: [],
      messageCount: 4,
    }
    const stalePopulatedChat = {
      ...regularChat,
      id: 'chat-populated',
      messageCount: 0,
    }

    expect(
      filterExportableChats([staleEmptyChat, stalePopulatedChat], true),
    ).toEqual([stalePopulatedChat])
  })
})
