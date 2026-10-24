import { ChatSearchModal } from '@/components/chat/chat-search-modal'
import { PLACEHOLDER_CHAT_TITLE } from '@/constants/chat'
import type { HarnessErrorBody } from '@/services/harness/types'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchState = {
  results: [] as {
    id: string
    title: string
    titleState?: 'placeholder' | 'generated' | 'manual'
    messageCount: number
    projectId?: string
  }[],
  unreadable: 0,
  isSearching: false,
  isIndexing: false,
  failure: null as HarnessErrorBody | null,
  retry: vi.fn(),
  available: true,
}

vi.mock('@/hooks/use-chat-search', () => ({
  useChatSearch: () => searchState,
  useChatsOutsideProjects: () => [],
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
    searchState.unreadable = 0
    searchState.failure = null
    searchState.retry = vi.fn()
    searchState.isSearching = false
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

  it('shows a found chat still waiting for its title as Untitled', () => {
    searchState.results = [
      {
        id: 'waiting',
        title: PLACEHOLDER_CHAT_TITLE,
        titleState: 'placeholder',
        messageCount: 2,
      },
    ]
    renderModal({ searchEnabled: true })
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'lamb' },
    })
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Untitled'])
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

  it('excludes blank and temporary chats from recents and local search', () => {
    renderModal({
      chats: [
        ...chats,
        { id: 'blank', title: 'Grilling blank', isBlankChat: true },
        { id: 'temporary', title: 'Grilling temporary', isTemporary: true },
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

  // A failure is described by what its error says, and runs again only when
  // its action allows it.
  it.each([
    {
      failure: {
        code: 'UPSTREAM_REFUSED',
        action: 'retry',
        message: 'The sync service could not fetch the data in time',
      },
      shown: "The search didn't finish. Try again.",
      canRetry: true,
    },
    {
      failure: {
        code: 'INVALID_RESPONSE',
        action: 'stop',
        message: 'The chat service sent a response this client cannot read.',
      },
      shown: "This search couldn't be completed.",
      canRetry: false,
    },
  ] as const)(
    'explains a search failed with $failure.code',
    ({ failure, shown, canRetry }) => {
      searchState.failure = { ...failure }
      renderModal({ searchEnabled: true })
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'peroxide' },
      })
      expect(screen.getByRole('listbox')).toHaveTextContent(shown)
      expect(screen.getByRole('listbox')).not.toHaveTextContent('unavailable')
      const retry = screen.queryByRole('button', { name: 'Try again' })
      if (canRetry) fireEvent.click(retry!)
      else expect(retry).not.toBeInTheDocument()
      expect(searchState.retry).toHaveBeenCalledTimes(canRetry ? 1 : 0)
    },
  )

  it('shows a failed search below the chats that match by title', () => {
    searchState.failure = {
      code: 'UPSTREAM_REFUSED',
      action: 'retry',
      message: 'The sync service could not fetch the data in time',
    }
    renderModal({
      chats: [{ id: 'local', title: 'Local pond notes', isLocalOnly: true }],
      searchEnabled: true,
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pond' } })
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Local pond notes'])
    expect(screen.getByRole('status')).toHaveTextContent(
      "The search didn't finish. Try again.",
    )
  })

  it('says how many matching chats could not be opened', () => {
    searchState.unreadable = 2
    const { rerender } = renderModal({ searchEnabled: true })
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'peroxide' },
    })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByRole('listbox')).toHaveTextContent(
      "2 matching chats couldn't be opened.",
    )
    expect(screen.getByRole('listbox')).not.toHaveTextContent('No matches.')

    searchState.results = [
      { id: 'found', title: 'Acne treatment options', messageCount: 2 },
    ]
    rerender({ searchEnabled: true })
    expect(
      screen.getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Acne treatment options'])
    expect(screen.getByRole('listbox')).toHaveTextContent(
      "2 matching chats couldn't be opened.",
    )
  })
})
