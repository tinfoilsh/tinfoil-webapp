'use client'

import { cn } from '@/components/ui/utils'
import { useChatSearch } from '@/hooks/use-chat-search'
import type { Project } from '@/types/project'
import { isSearchableChat } from '@/utils/chat-search-visibility'
import {
  FolderIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IoChatbubbleOutline } from 'react-icons/io5'
import { CONSTANTS } from './constants'
import type { Chat } from './types'

type SearchTab = 'chats' | 'projects'

const SEARCH_TABS: { id: SearchTab; label: string }[] = [
  { id: 'chats', label: 'Chats' },
  { id: 'projects', label: 'Projects' },
]

const SEARCH_TAB_CLASS_NAME =
  'rounded-lg border px-3 py-1 text-xs font-medium transition-colors'
const SEARCH_TAB_ACTIVE_CLASS_NAME =
  'border-tinfoil-accent-blue bg-tinfoil-accent-blue text-white'
const SEARCH_TAB_INACTIVE_CLASS_NAME =
  'border-transparent text-content-secondary hover:border-border-subtle hover:text-content-primary'

export interface SearchableChat {
  id: string
  title: string
  updatedAt?: Date | string
  projectId?: string
  isBlankChat?: boolean
  isTemporary?: boolean
  decryptionFailed?: boolean
  dataCorrupted?: boolean
  isLocalOnly?: boolean
}

interface ChatSearchModalProps {
  isOpen: boolean
  onClose: () => void
  chats: SearchableChat[]
  projects: Pick<Project, 'id' | 'name'>[]
  /** Server-side search is only possible for signed-in users with cloud sync. */
  searchEnabled: boolean
  isPremium: boolean
  onOpenChat: (chat: Pick<Chat, 'id' | 'projectId'>) => void | Promise<void>
  onOpenProject: (
    project: Pick<Project, 'id' | 'name'>,
  ) => void | Promise<unknown>
}

type ResultRow =
  | { kind: 'chat'; id: string; title: string; projectId?: string }
  | { kind: 'project'; id: string; name: string }

const toTime = (value?: Date | string): number => {
  if (!value) return 0
  const time =
    value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

export function ChatSearchModal({
  isOpen,
  onClose,
  chats,
  projects,
  searchEnabled,
  isPremium,
  onOpenChat,
  onOpenProject,
}: ChatSearchModalProps) {
  const [term, setTerm] = useState('')
  const [tab, setTab] = useState<SearchTab>('chats')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const trimmed = term.trim()
  const needle = trimmed.toLowerCase()
  const search = useChatSearch(term, isOpen && searchEnabled, isPremium)

  useEffect(() => {
    if (!isOpen) {
      setTerm('')
      setTab('chats')
      setActiveIndex(0)
    }
  }, [isOpen])

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const savedChats = useMemo(() => chats.filter(isSearchableChat), [chats])

  const recentChats = useMemo(
    () =>
      [...savedChats]
        .filter((chat) => !chat.projectId)
        .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))
        .slice(0, CONSTANTS.SEARCH_RECENT_CHAT_COUNT),
    [savedChats],
  )

  const matchingChats = useMemo(() => {
    if (!needle) return []
    const localMatches = savedChats.filter((chat) =>
      chat.title.toLowerCase().includes(needle),
    )
    let matches: SearchableChat[] = localMatches
    if (searchEnabled && search.available) {
      const remoteMatches = search.isSearching ? [] : search.results
      const remoteIds = new Set(remoteMatches.map((chat) => chat.id))
      matches = [
        ...remoteMatches,
        ...localMatches.filter(
          (chat) => chat.isLocalOnly && !remoteIds.has(chat.id),
        ),
      ]
    }
    return matches.map((chat) => ({
      kind: 'chat' as const,
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
    }))
  }, [
    searchEnabled,
    search.available,
    search.isSearching,
    search.results,
    savedChats,
    needle,
  ])

  const chatRows = useMemo((): ResultRow[] => {
    if (!needle) {
      return recentChats.map((chat) => ({
        kind: 'chat',
        id: chat.id,
        title: chat.title,
      }))
    }
    return matchingChats.filter((chat) => !chat.projectId)
  }, [needle, recentChats, matchingChats])

  const projectRows = useMemo((): ResultRow[] => {
    if (!isPremium) return []
    const matchingProjects: ResultRow[] = projects
      .filter(
        (project) => !needle || project.name.toLowerCase().includes(needle),
      )
      .map((project) => ({
        kind: 'project',
        id: project.id,
        name: project.name,
      }))

    if (!needle) return matchingProjects

    const projectChats = matchingChats.filter((chat) => chat.projectId)

    return [...matchingProjects, ...projectChats]
  }, [isPremium, needle, projects, matchingChats])

  const rows = tab === 'chats' ? chatRows : projectRows

  useEffect(() => {
    setActiveIndex(0)
  }, [tab, needle, rows.length])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    )
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const openRow = (row: ResultRow) => {
    onClose()
    if (row.kind === 'project') {
      void onOpenProject({ id: row.id, name: row.name })
    } else {
      void onOpenChat({ id: row.id, projectId: row.projectId })
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (rows.length > 0) setActiveIndex((i) => (i + 1) % rows.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length > 0)
        setActiveIndex((i) => (i - 1 + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      const row = rows[activeIndex]
      if (row) {
        event.preventDefault()
        openRow(row)
      }
    }
  }

  const isSearching = Boolean(needle) && searchEnabled && search.isSearching
  const showIndexing = Boolean(needle) && searchEnabled && search.isIndexing
  const searchFailed = Boolean(needle) && searchEnabled && search.failed

  let emptyMessage: string
  if (tab === 'projects' && !isPremium)
    emptyMessage = 'Projects require a Pro subscription.'
  else if (searchFailed) emptyMessage = 'Search is unavailable right now.'
  else if (isSearching) emptyMessage = 'Searching...'
  else if (needle) emptyMessage = 'No matches.'
  else if (tab === 'chats') emptyMessage = 'No chats yet.'
  else emptyMessage = 'No projects yet.'

  const sectionLabel = needle
    ? tab === 'chats'
      ? 'Results'
      : 'Projects and project chats'
    : tab === 'chats'
      ? 'Recent chats'
      : 'Your projects'

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="flex max-h-[70dvh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-sidebar shadow-xl focus:outline-none"
          >
            <DialogPrimitive.Title className="sr-only">
              Search chats and projects
            </DialogPrimitive.Title>

            <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
              <MagnifyingGlassIcon
                className="h-4 w-4 flex-none text-content-muted"
                aria-hidden="true"
              />
              <input
                autoFocus
                onKeyDown={handleKeyDown}
                type="text"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Search..."
                aria-label="Search chats and projects"
                className="min-w-0 flex-1 bg-transparent font-aeonik text-base text-content-primary placeholder:text-content-muted focus:outline-none"
              />
              <DialogPrimitive.Close
                aria-label="Close search"
                className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-chat hover:text-content-primary"
              >
                <XMarkIcon className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>

            <div
              role="tablist"
              aria-label="Search scope"
              className="flex gap-2 border-b border-border-subtle px-4 py-2"
            >
              {SEARCH_TABS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === option.id}
                  onClick={() => setTab(option.id)}
                  className={cn(
                    SEARCH_TAB_CLASS_NAME,
                    tab === option.id
                      ? SEARCH_TAB_ACTIVE_CLASS_NAME
                      : SEARCH_TAB_INACTIVE_CLASS_NAME,
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div
              ref={listRef}
              role="listbox"
              aria-label={sectionLabel}
              className="min-h-[200px] flex-1 overflow-y-auto px-2 py-2"
            >
              <p className="px-3 pb-2 pt-1 font-aeonik-fono text-xs text-content-muted">
                {sectionLabel}
              </p>
              {rows.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-content-muted">
                  {emptyMessage}
                </p>
              ) : (
                rows.map((row, index) => {
                  const isActive = index === activeIndex
                  const projectName =
                    row.kind === 'chat' && row.projectId
                      ? projectNameById.get(row.projectId)
                      : undefined
                  return (
                    <button
                      key={`${row.kind}-${row.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-index={index}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => openRow(row)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                        isActive
                          ? 'bg-surface-chat text-content-primary'
                          : 'text-content-secondary hover:bg-surface-chat/60',
                      )}
                    >
                      {row.kind === 'project' ? (
                        <FolderIcon
                          className="h-4 w-4 flex-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <IoChatbubbleOutline
                          className="h-4 w-4 flex-none"
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {row.kind === 'project' ? row.name : row.title}
                      </span>
                      {projectName && (
                        <span className="flex-none truncate font-aeonik-fono text-xs text-content-muted">
                          {projectName}
                        </span>
                      )}
                    </button>
                  )
                })
              )}
              {isSearching && rows.length > 0 && (
                <p
                  role="status"
                  className="px-3 pt-2 font-aeonik-fono text-xs text-content-muted"
                >
                  Searching synced chats...
                </p>
              )}
              {showIndexing && (
                <p className="px-3 pt-2 font-aeonik-fono text-xs text-content-muted">
                  The search index is still being built; results may be
                  incomplete.
                </p>
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-border-subtle px-4 py-2 font-aeonik-fono text-xs text-content-muted">
              <span>
                <kbd className="rounded border border-border-subtle px-1">
                  Esc
                </kbd>{' '}
                Close
              </span>
              <span>
                <kbd className="rounded border border-border-subtle px-1">
                  Tab
                </kbd>{' '}
                Move focus
              </span>
              <span>
                <kbd className="rounded border border-border-subtle px-1">
                  ↵
                </kbd>{' '}
                Open
              </span>
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
