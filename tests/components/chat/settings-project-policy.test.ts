import {
  canDeleteAllProjects,
  canTransferProjectData,
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
  it('keeps delete-all available while hiding project transfer controls', () => {
    expect(canDeleteAllProjects(true)).toBe(true)
    expect(canTransferProjectData(false)).toBe(false)
  })

  it('excludes project chats from free-user exports without deleting them', () => {
    const chats = [regularChat, projectChat]

    expect(filterExportableChats(chats, false)).toEqual([regularChat])
    expect(chats).toEqual([regularChat, projectChat])
    expect(filterExportableChats(chats, true)).toEqual(chats)
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

  it('counts project chats omitted from a free-user export', () => {
    expect(countExcludedProjectChats([regularChat, projectChat], false)).toBe(1)
    expect(countExcludedProjectChats([regularChat, projectChat], true)).toBe(0)
  })
})
