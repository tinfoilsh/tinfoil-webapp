import { SafeguardsSettings } from '@/components/chat/safeguards-settings'
import { useSafeguards } from '@/hooks/use-safeguards'
import {
  refreshSafeguards,
  type SafeguardsSnapshot,
} from '@/services/safeguards'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-safeguards', () => ({ useSafeguards: vi.fn() }))
vi.mock('@/services/safeguards', () => ({
  SAFEGUARDS_INFO_URL: 'https://tinfoil.sh/safety-and-safeguards',
  refreshSafeguards: vi.fn().mockResolvedValue(undefined),
}))

const RECENT_FLAG = {
  id: 'flag-1',
  conversationId: 'chat-1',
  createdAt: Date.now(),
}
const OLD_FLAG = {
  id: 'flag-2',
  conversationId: 'chat-2',
  createdAt: Date.parse('2000-01-01T00:00:00Z'),
}
const POLICY = {
  inWindow: 0,
  windowHours: 48,
  warnThreshold: 3,
  banThreshold: 4,
}

function setSnapshot(overrides: Partial<SafeguardsSnapshot> = {}) {
  vi.mocked(useSafeguards).mockReturnValue({
    flaggedChats: [],
    flaggedChatIds: {},
    policy: null,
    status: 'loading',
    ...overrides,
  })
}

function progressBar() {
  return screen.getByRole('progressbar', {
    name: 'Flags toward account suspension',
  })
}

describe('SafeguardsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setSnapshot()
  })

  it('never surfaces a local-preview label: mock and real data render identically', () => {
    setSnapshot({ status: 'ready', policy: POLICY })
    render(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)
    expect(screen.queryByText(/Local preview/i)).not.toBeInTheDocument()
  })

  it('splits the explanation into three headed sections with the policy link', () => {
    render(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)

    expect(
      screen
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Flagged Chats', 'How it works'])

    expect(
      screen
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Your conversations stay private',
      'Safeguards assess model responses',
      'Only a flag leaves the enclave',
    ])
    expect(
      screen.getByRole('link', { name: 'Learn how safeguards work' }),
    ).toHaveAttribute('href', 'https://tinfoil.sh/safety-and-safeguards')
  })

  it.each([true, false])(
    'keeps the track mounted from loading through a zero-flags response (dark=%s)',
    (isDarkMode) => {
      const view = (
        <SafeguardsSettings
          isDarkMode={isDarkMode}
          onNavigateToChat={vi.fn()}
        />
      )
      const { rerender } = render(view)
      const track = progressBar()
      expect(track).not.toHaveAttribute('aria-valuenow')
      expect(track).toHaveAttribute('aria-valuetext', 'Loading')
      expect(screen.getByText('Loading flag count…')).toBeVisible()
      expect(
        screen.queryByText(/No flagged chats in the last/),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText(/more before account suspension/),
      ).not.toBeInTheDocument()

      setSnapshot({ status: 'ready', policy: POLICY })
      rerender(
        <SafeguardsSettings
          isDarkMode={isDarkMode}
          onNavigateToChat={vi.fn()}
        />,
      )

      expect(progressBar()).toBe(track)
      expect(track).toHaveAttribute('aria-valuenow', '0')
      expect(track).toHaveAttribute('aria-valuetext', '0 of 4 flags')
      expect(screen.getByText('0 of 4 flags in the last 2 days')).toBeVisible()
      expect(screen.getByText('4 more before account suspension')).toBeVisible()
      expect(
        screen.getByText('No flagged chats in the last 2 days.'),
      ).toBeVisible()
      expect(screen.queryByRole('list')).not.toBeInTheDocument()
    },
  )

  it('uses the server window count, not the length of the flag history, and keeps chat links', () => {
    setSnapshot({
      status: 'ready',
      policy: { ...POLICY, inWindow: 1 },
      flaggedChats: [RECENT_FLAG, OLD_FLAG],
    })
    const onNavigate = vi.fn()
    render(<SafeguardsSettings isDarkMode onNavigateToChat={onNavigate} />)

    expect(progressBar()).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('3 more before account suspension')).toBeVisible()
    expect(screen.getByRole('link', { name: /chat-2/ })).toHaveAttribute(
      'href',
      '/chat/chat-2',
    )
    const chatLink = screen.getByRole('link', { name: /chat-1/ })
    chatLink.addEventListener('click', (event) => event.preventDefault())
    fireEvent.click(chatLink)
    expect(onNavigate).toHaveBeenCalledOnce()
  })

  it('uses local and project routes without changing the flagged conversation ID', () => {
    setSnapshot({
      status: 'ready',
      policy: { ...POLICY, inWindow: 1 },
      flaggedChats: [RECENT_FLAG],
    })
    const { rerender } = render(
      <SafeguardsSettings
        isDarkMode
        onNavigateToChat={vi.fn()}
        chats={[{ id: RECENT_FLAG.conversationId, isLocalOnly: true }]}
      />,
    )
    expect(screen.getByRole('link', { name: /chat-1/ })).toHaveAttribute(
      'href',
      '/chat/local/chat-1',
    )

    rerender(
      <SafeguardsSettings
        isDarkMode
        onNavigateToChat={vi.fn()}
        chats={[{ id: RECENT_FLAG.conversationId, isLocalOnly: false }]}
      />,
    )
    expect(screen.getByRole('link', { name: /chat-1/ })).toHaveAttribute(
      'href',
      '/chat/chat-1',
    )

    rerender(
      <SafeguardsSettings
        isDarkMode
        onNavigateToChat={vi.fn()}
        chats={[{ id: RECENT_FLAG.conversationId, projectId: 'project-1' }]}
      />,
    )
    expect(screen.getByRole('link', { name: /chat-1/ })).toHaveAttribute(
      'href',
      '/project/project-1/chat/chat-1',
    )
  })

  it('shows zero progress and the recent empty state even when older flags remain', () => {
    setSnapshot({ status: 'ready', policy: POLICY, flaggedChats: [OLD_FLAG] })
    render(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)

    expect(progressBar()).toHaveAttribute('aria-valuenow', '0')
    expect(
      screen.getByText('No flagged chats in the last 2 days.'),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: /chat-2/ })).toBeVisible()
  })

  it('keeps an unknown track on failure and allows a retry without pretending there are zero flags', () => {
    setSnapshot({ status: 'error' })
    const { rerender } = render(
      <SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />,
    )
    const track = progressBar()
    expect(track).not.toHaveAttribute('aria-valuenow')
    expect(track).toHaveAttribute('aria-valuetext', 'Unavailable')
    expect(screen.getByText('Flag count unavailable')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load flagged chats.',
    )
    expect(
      screen.queryByText(/No flagged chats in the last/),
    ).not.toBeInTheDocument()

    vi.mocked(refreshSafeguards).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refreshSafeguards).toHaveBeenCalledOnce()
    setSnapshot()
    rerender(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)
    expect(progressBar()).toBe(track)
    expect(track).toHaveAttribute('aria-valuetext', 'Loading')
  })

  it('keeps known progress and links during refresh and explicitly labels stale data on failure', () => {
    const snapshot = {
      policy: { ...POLICY, inWindow: 2 },
      flaggedChats: [RECENT_FLAG],
    }
    setSnapshot({ ...snapshot, status: 'ready' })
    const { rerender } = render(
      <SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />,
    )
    const track = progressBar()

    setSnapshot({ ...snapshot, status: 'loading' })
    rerender(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)
    expect(progressBar()).toBe(track)
    expect(track).toHaveAttribute('aria-valuenow', '50')
    expect(
      screen.getByRole('button', { name: 'Refresh flagged chats' }),
    ).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Refreshing flagged chats…',
    )

    setSnapshot({ ...snapshot, status: 'error' })
    rerender(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)
    expect(progressBar()).toBe(track)
    expect(track).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Showing the last loaded flags.',
    )
    expect(screen.getByRole('link', { name: /chat-1/ })).toBeVisible()
  })

  it('highlights the warning boundary while one flag remains before suspension', () => {
    setSnapshot({ status: 'ready', policy: { ...POLICY, inWindow: 2 } })
    const { rerender } = render(
      <SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />,
    )
    expect(screen.getByText('2 more before account suspension')).toHaveClass(
      'text-content-muted',
    )

    setSnapshot({ status: 'ready', policy: { ...POLICY, inWindow: 3 } })
    rerender(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)
    expect(progressBar()).toHaveAttribute('aria-valuenow', '75')
    expect(screen.getByText('1 more before account suspension')).toHaveClass(
      'text-red-600',
    )
    expect(
      screen.queryByText('Suspension limit reached'),
    ).not.toBeInTheDocument()
  })

  it.each([4, 6])(
    'caps progress at the limit without a negative remaining count (%s flags)',
    (inWindow) => {
      setSnapshot({ status: 'ready', policy: { ...POLICY, inWindow } })
      render(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)

      expect(progressBar()).toHaveAttribute('aria-valuenow', '100')
      expect(screen.getByText('Suspension limit reached')).toBeVisible()
      expect(
        screen.queryByText(/more before account suspension/),
      ).not.toBeInTheDocument()
    },
  )

  it.each([
    [24, '1 day'],
    [25, '25 hours'],
  ])(
    'displays the exact server window of %s hours',
    (windowHours, description) => {
      setSnapshot({
        status: 'ready',
        policy: { ...POLICY, windowHours: Number(windowHours) },
      })
      render(<SafeguardsSettings isDarkMode onNavigateToChat={vi.fn()} />)

      expect(
        screen.getByText(`No flagged chats in the last ${description}.`),
      ).toBeVisible()
    },
  )
})
