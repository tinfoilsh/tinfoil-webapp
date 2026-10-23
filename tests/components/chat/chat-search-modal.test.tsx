import { ChatSearchModal } from '@/components/chat/chat-search-modal'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchState = {
  results: [] as {
    id: string
    title: string
    messageCount: number
    projectId?: string
  }[],
  isSearching: false,
  isIndexing: false,
  failed: false,
  available: true,
}

vi.mock('@/hooks/use-chat-search', () => ({
  useChatSearch: () => searchState,
}))

const chats = [
  { id: 'c1', title: 'Grilling lamb', updatedAt: '2026-08-01T00:00:00Z' },
  { id: 'c2', title: 'Brand guide fonts', updatedAt: '2026-08-03T00:00:00Z' },
  {
    id: 'p1c',
    title: 'Roadmap draft',
    updatedAt: '2026-08-02T00:00:00Z',
    projectId: 'proj-1',
  },
]
const projects = [{ id: 'proj-1', name: 'Launch plan' }]

function renderModal(
  overrides: Partial<Parameters<typeof ChatSearchModal>[0]> = {},
) {
  const onOpenChat = vi.fn()
  const onOpenProject = vi.fn()
  const onClose = vi.fn()
  const props = {
    isOpen: true,
    onClose,
    chats,
    projects,
    searchEnabled: false,
    isPremium: true,
    onOpenChat,
    onOpenProject,
    ...overrides,
  }
  const view = render(<ChatSearchModal {...props} />)
  return {
    onOpenChat,
    onOpenProject,
    onClose,
    rerender: (next: Partial<Parameters<typeof ChatSearchModal>[0]>) =>
      view.rerender(<ChatSearchModal {...props} {...next} />),
  }
}

describe('ChatSearchModal', () => {
  beforeEach(() => {
    searchState.results = []
    searchState.available = true
    searchState.failed = false
    searchState.isSearching = false
    searchState.isIndexing = false
  })

  it('lists recent non-project chats newest first before a term is typed', () => {
    renderModal()

    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Brand guide fonts',
      'Grilling lamb',
    ])
    expect(screen.getByText('Recent chats')).toBeInTheDocument()
  })

  it('filters locally by title when server search is unavailable', () => {
    renderModal()

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'lamb' },
    })

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Grilling lamb')).toBeInTheDocument()
  })

  it('shows projects and their chats under the Projects tab', () => {
    const { onOpenProject, onOpenChat, onClose } = renderModal()

    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    expect(
      screen.getByRole('option', { name: 'Launch plan' }),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'roadmap' },
    })
    const projectChat = screen.getByRole('option', { name: /Roadmap draft/ })
    expect(projectChat).toHaveTextContent('Launch plan')

    fireEvent.click(projectChat)
    expect(onOpenChat).toHaveBeenCalledWith({ id: 'p1c', projectId: 'proj-1' })
    expect(onClose).toHaveBeenCalled()
    expect(onOpenProject).not.toHaveBeenCalled()
  })

  it('supports result keyboard navigation without intercepting ordinary Tab', () => {
    const { onOpenChat, onOpenProject } = renderModal()
    const input = screen.getByRole('textbox')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpenChat).toHaveBeenCalledWith({ id: 'c1', projectId: undefined })

    const tabEvent = createEvent.keyDown(input, {
      key: 'Tab',
      cancelable: true,
    })
    fireEvent(input, tabEvent)
    expect(tabEvent.defaultPrevented).toBe(false)
    expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpenProject).toHaveBeenCalledWith({
      id: 'proj-1',
      name: 'Launch plan',
    })
  })

  it('does not intercept Enter on the close or scope controls', () => {
    const { onOpenChat, onClose } = renderModal()
    for (const control of [
      screen.getByRole('button', { name: 'Close search' }),
      screen.getByRole('tab', { name: 'Projects' }),
    ]) {
      const event = createEvent.keyDown(control, {
        key: 'Enter',
        cancelable: true,
      })
      fireEvent(control, event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(onOpenChat).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('excludes blank, temporary, and undecryptable chats from recents and local search', () => {
    renderModal({
      chats: [
        ...chats,
        { id: 'blank', title: 'Grilling blank', isBlankChat: true },
        { id: 'temporary', title: 'Grilling temporary', isTemporary: true },
        { id: 'locked', title: 'Grilling locked', decryptionFailed: true },
      ],
    })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Grilling' },
    })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Grilling lamb')
  })

  it('does not expose cached projects or project chats after premium access is lost', () => {
    searchState.available = false
    const { rerender } = renderModal({ searchEnabled: true })
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    expect(
      screen.getByRole('option', { name: 'Launch plan' }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'roadmap' },
    })
    expect(
      screen.getByRole('option', { name: /Roadmap draft/ }),
    ).toBeInTheDocument()
    rerender({ searchEnabled: true, isPremium: false })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(
      screen.getByText('Projects require a Pro subscription.'),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(screen.queryByText('Launch plan')).not.toBeInTheDocument()
  })

  it('does not show stale server hits while the current query is searching', () => {
    searchState.results = [
      { id: 'old', title: 'Previous result', messageCount: 2 },
    ]
    searchState.isSearching = true
    renderModal({ searchEnabled: true })
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'new query' },
    })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText('Searching...')).toBeInTheDocument()
  })

  it('shows an ongoing rebuild even before any current-query results arrive', () => {
    searchState.isIndexing = true
    searchState.isSearching = true
    renderModal({ searchEnabled: true })
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'new query' },
    })
    expect(
      screen.getByText(/The search index is still being built/),
    ).toBeInTheDocument()
  })

  it('uses server results when encrypted search is available', () => {
    searchState.results = [
      { id: 'remote', title: 'From the enclave', messageCount: 3 },
      {
        id: 'remote-project',
        title: 'Project hit',
        messageCount: 1,
        projectId: 'proj-1',
      },
    ]
    renderModal({ searchEnabled: true })

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'anything' },
    })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'From the enclave',
    ])

    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    expect(
      screen.getByRole('option', { name: /Project hit/ }),
    ).toBeInTheDocument()
  })

  it('includes local-only title matches while cloud search is available, without duplicate IDs', () => {
    searchState.results = [
      { id: 'cloud', title: 'Cloud pond notes', messageCount: 2 },
      { id: 'shared', title: 'Pond copy', messageCount: 2 },
    ]
    const localChats = [
      { id: 'local', title: 'Local pond notes', isLocalOnly: true },
      { id: 'shared', title: 'Pond copy', isLocalOnly: true },
      {
        id: 'hidden',
        title: 'Corrupt pond notes',
        isLocalOnly: true,
        dataCorrupted: true,
      },
      { id: 'cached-cloud', title: 'Cached cloud pond notes' },
    ]
    renderModal({ chats: localChats, searchEnabled: true })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pond' } })
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Cloud pond notes', 'Pond copy', 'Local pond notes'])
  })

  it('shows current local-only matches while remote results are pending', () => {
    searchState.isSearching = true
    searchState.results = [
      { id: 'old', title: 'Old cloud result', messageCount: 2 },
    ]
    renderModal({
      chats: [{ id: 'local', title: 'Local pond notes', isLocalOnly: true }],
      searchEnabled: true,
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pond' } })
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Local pond notes'])
    expect(screen.getByRole('status')).toHaveTextContent(
      'Searching synced chats...',
    )
  })
})
