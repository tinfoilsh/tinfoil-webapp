import { ShareModal } from '@/components/chat/share-modal'
import { harnessAPI } from '@/services/harness/runtime'
import { SHARE_TOO_LARGE_MESSAGE } from '@/services/harness/shares'
import { HarnessError } from '@/services/harness/sse'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  share: vi.fn<(chatId: string) => Promise<string>>(),
  status: vi.fn<(threadId: string) => Promise<{ shared: boolean }>>(),
  revoke: vi.fn<(threadId: string) => Promise<object>>(),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))
vi.mock('@tinfoilsh/tinfoil-icons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tinfoilsh/tinfoil-icons')>()),
  TfGlobe: () => <svg data-testid="globe-icon" />,
  TfLockLocked: () => <svg data-testid="lock-icon" />,
}))

const SHARE_URL = 'https://chat.tinfoil.sh/share/chat-id#v2:' + 'ab'.repeat(32)
const NEXT_URL = 'https://chat.tinfoil.sh/share/chat-id#v2:' + 'cd'.repeat(32)
const props = {
  isOpen: true,
  onClose: vi.fn(),
  messages: [],
  isDarkMode: false,
  chatId: 'chat-id',
  share: mocks.share,
  canRevoke: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function readyCheckbox() {
  const checkbox = screen.getByRole('checkbox', {
    name: 'Make this conversation shareable with anyone who has the link',
  })
  await waitFor(() => expect(checkbox).toBeEnabled())
  return checkbox
}

let shared: boolean

beforeEach(() => {
  shared = false
  mocks.toast.mockReset()
  props.onClose.mockReset()
  mocks.share.mockReset().mockImplementation(async () => {
    shared = true
    return SHARE_URL
  })
  mocks.status
    .mockReset()
    .mockImplementation(async () => ({ shared: shared as boolean }))
  mocks.revoke.mockReset().mockImplementation(async () => {
    shared = false
    return {}
  })
  vi.mocked(harnessAPI().client.post).mockImplementation(
    async (path: string, input: unknown) => {
      const { threadId } = input as { threadId: string }
      if (path === '/v1/threads/share/status') return mocks.status(threadId)
      if (path === '/v1/threads/share/revoke') return mocks.revoke(threadId)
      throw new Error(`Unexpected request: ${path}`)
    },
  )
})

afterEach(cleanup)

describe('ShareModal', () => {
  it('shows the conversation as raw markdown', () => {
    render(
      <ShareModal
        {...props}
        messages={[
          { role: 'user', content: 'Hello', timestamp: new Date(0) },
          { role: 'assistant', content: 'Hi there', timestamp: new Date(1) },
        ]}
      />,
    )
    expect(screen.getByLabelText('Raw conversation markdown').textContent).toBe(
      '## User\n\nHello\n\n---\n\n## Assistant\n\nHi there\n\n---',
    )
  })

  it('reads the text of stored documents into the markdown', async () => {
    const load = vi.fn(async () => 'Revenue grew.')
    render(
      <ShareModal
        {...props}
        loadDocumentText={load}
        messages={[
          {
            role: 'user',
            content: 'See attached',
            timestamp: new Date(0),
            attachments: [
              { id: 'att_report', type: 'document', fileName: 'report.pdf' },
              {
                id: 'att_notes',
                type: 'document',
                fileName: 'notes.txt',
                textContent: 'Inline notes',
              },
            ],
          },
        ]}
      />,
    )

    await waitFor(() =>
      expect(
        screen.getByLabelText('Raw conversation markdown').textContent,
      ).toBe(
        [
          '## User',
          '',
          'See attached',
          '',
          '**Attachments:**',
          '- report.pdf',
          '- notes.txt',
          '',
          '**Document Content:**',
          '```',
          'Document title: report.pdf',
          'Revenue grew.',
          '',
          'Document title: notes.txt',
          'Inline notes',
          '```',
          '',
          '---',
        ].join('\n'),
      ),
    )
    expect(load).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'att_report' }),
    )
  })

  it('reads a document again when the dialog reopens after its read failed while closed', async () => {
    const first = deferred<string>()
    const load = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('Revenue grew.')
    const messages = [
      {
        role: 'user' as const,
        content: 'See attached',
        timestamp: new Date(0),
        attachments: [
          {
            id: 'att_report',
            type: 'document' as const,
            fileName: 'report.pdf',
          },
        ],
      },
    ]
    const { rerender } = render(
      <ShareModal {...props} loadDocumentText={load} messages={messages} />,
    )
    expect(load).toHaveBeenCalledOnce()
    rerender(
      <ShareModal
        {...props}
        isOpen={false}
        loadDocumentText={load}
        messages={messages}
      />,
    )
    await act(async () => first.reject(new Error('Offline')))

    rerender(
      <ShareModal {...props} loadDocumentText={load} messages={messages} />,
    )

    await waitFor(() =>
      expect(
        screen.getByLabelText('Raw conversation markdown').textContent,
      ).toContain('Document title: report.pdf\nRevenue grew.'),
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('waits for the next opening to read a document whose read failed while open', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Offline'))
    const message = {
      role: 'user' as const,
      content: 'See attached',
      timestamp: new Date(0),
      attachments: [
        { id: 'att_report', type: 'document' as const, fileName: 'report.pdf' },
      ],
    }
    const reply = {
      role: 'assistant' as const,
      content: 'Hi',
      timestamp: new Date(1),
    }
    const { rerender } = render(
      <ShareModal {...props} loadDocumentText={load} messages={[message]} />,
    )
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => {})

    // A reply streaming in changes the messages while the dialog stays open.
    rerender(
      <ShareModal
        {...props}
        loadDocumentText={load}
        messages={[message, reply]}
      />,
    )
    expect(load).toHaveBeenCalledOnce()

    rerender(
      <ShareModal
        {...props}
        isOpen={false}
        loadDocumentText={load}
        messages={[message, reply]}
      />,
    )
    rerender(
      <ShareModal
        {...props}
        loadDocumentText={load}
        messages={[message, reply]}
      />,
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('creates a link through the harness, focuses it, and only then shows the chat as shared', async () => {
    const created = deferred<string>()
    mocks.share.mockReturnValueOnce(created.promise)
    render(<ShareModal {...props} />)
    const checkbox = await readyCheckbox()
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith('chat-id')
    expect(screen.getByText('Private')).toBeVisible()
    expect(screen.getByTestId('lock-icon')).toBeInTheDocument()

    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    // The checkbox is the user's intent; the icon follows actual access.
    expect(screen.getByText('Private')).toBeVisible()
    expect(screen.getByTestId('lock-icon')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith('chat-id')
    expect(screen.getByText('Private')).toBeVisible()

    await act(async () => created.resolve(SHARE_URL))
    const link = screen.getByRole('textbox', { name: 'Share link' })
    expect(link).toHaveValue(SHARE_URL)
    expect(screen.getByText('Shareable link access')).toBeVisible()
    expect(screen.getByTestId('globe-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('lock-icon')).not.toBeInTheDocument()
    await waitFor(() => expect(link).toHaveFocus())
  })

  it('revokes a created link, clears it, and requires a fresh link when reenabled', async () => {
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(
      await screen.findByRole('textbox', { name: 'Share link' }),
    ).toHaveValue(SHARE_URL)

    const revocation = deferred<object>()
    mocks.revoke.mockImplementationOnce(async () => {
      await revocation.promise
      shared = false
      return {}
    })
    fireEvent.click(await readyCheckbox())
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Close share dialog' }),
    ).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('chat-id')

    await act(async () => revocation.resolve({}))
    expect(await screen.findByText('Private')).toBeVisible()
    expect(
      screen.queryByRole('textbox', { name: 'Share link' }),
    ).not.toBeInTheDocument()
    expect(shared).toBe(false)
    expect(
      screen.getByRole('button', { name: 'Close share dialog' }),
    ).toBeEnabled()

    fireEvent.click(await readyCheckbox())
    expect(
      screen.queryByRole('textbox', { name: 'Share link' }),
    ).not.toBeInTheDocument()
    mocks.share.mockResolvedValueOnce(NEXT_URL)
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(
      await screen.findByRole('textbox', { name: 'Share link' }),
    ).toHaveValue(NEXT_URL)
    expect(mocks.share).toHaveBeenCalledTimes(2)
    expect(mocks.status).toHaveBeenCalledTimes(1)
  })

  it('cancels sharing locally when no link has been created', async () => {
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('checkbox')).toBeEnabled()
    expect(screen.getByText('Private')).toBeVisible()
    expect(mocks.revoke).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('discovers an existing share and revokes it without its link', async () => {
    shared = true
    render(<ShareModal {...props} />)
    expect(await readyCheckbox()).toBeChecked()
    expect(screen.getByText(/An existing link is active/)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Replace share link' }),
    ).toBeEnabled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByText('Private')).toBeVisible()
    expect(shared).toBe(false)
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('chat-id')
    expect(mocks.share).not.toHaveBeenCalled()
  })

  it('keeps sharing enabled when revocation fails and allows a retry', async () => {
    shared = true
    mocks.revoke.mockRejectedValueOnce(
      new HarnessError({ code: 'UPSTREAM_REFUSED', message: 'Offline' }, 502),
    )
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
        title: 'Could not disable sharing',
        description: 'The link may still be active. Please try again.',
        variant: 'destructive',
        position: 'top-left',
      }),
    )
    expect(await readyCheckbox()).toBeChecked()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
    expect(mocks.status).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByText('Private')).toBeVisible()
    expect(shared).toBe(false)
  })

  it('does not claim privacy while the status is unknown, and can retry', async () => {
    shared = true
    const status = deferred<{ shared: boolean }>()
    mocks.status.mockReturnValueOnce(status.promise)
    render(<ShareModal {...props} />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(
      screen.queryByRole('button', { name: 'Create share link' }),
    ).not.toBeInTheDocument()

    await act(async () => status.reject(new Error('Offline')))
    expect(screen.getByText('Share status unavailable')).toBeVisible()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry share status' }))
    expect(await readyCheckbox()).toBeChecked()
  })

  it('rechecks the status after a link is stored but its response is lost', async () => {
    mocks.share.mockImplementationOnce(async () => {
      shared = true
      throw new TypeError('Connection lost')
    })
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(await screen.findByText(/An existing link is active/)).toBeVisible()
    expect(await readyCheckbox()).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByText('Private')).toBeVisible()
    expect(shared).toBe(false)
  })

  it('refreshes the status when reopened after another device revokes the link', async () => {
    shared = true
    const view = render(<ShareModal {...props} />)
    expect(await readyCheckbox()).toBeChecked()
    view.rerender(<ShareModal {...props} isOpen={false} />)
    shared = false
    view.rerender(<ShareModal {...props} />)
    expect(await readyCheckbox()).not.toBeChecked()
    expect(screen.getByText('Private')).toBeVisible()
  })

  it('ignores a stale status response after reopening the same conversation', async () => {
    const status = deferred<{ shared: boolean }>()
    mocks.status.mockReturnValueOnce(status.promise)
    const view = render(<ShareModal {...props} />)
    view.rerender(<ShareModal {...props} isOpen={false} />)
    view.rerender(<ShareModal {...props} />)
    expect(await readyCheckbox()).not.toBeChecked()
    expect(mocks.status).toHaveBeenCalledTimes(2)

    await act(async () => status.resolve({ shared: true }))

    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByText('Private')).toBeVisible()
  })

  it('reports a refused share without showing a link', async () => {
    mocks.share.mockRejectedValueOnce(
      new HarnessError(
        { code: 'UPSTREAM_REFUSED', message: 'The chat could not be shared' },
        502,
      ),
    )
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
        title: 'Share failed',
        description: 'The chat could not be shared',
        variant: 'destructive',
        position: 'top-left',
      }),
    )
    expect(
      screen.queryByRole('textbox', { name: 'Share link' }),
    ).not.toBeInTheDocument()
    // The status is checked again, since a refusal may follow a stored link.
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2))
    expect(await readyCheckbox()).not.toBeChecked()
    expect(screen.getByText('Private')).toBeVisible()
  })

  it.each([
    [
      'the harness',
      new HarnessError(
        { code: 'THREAD_TOO_LARGE', message: 'The chat is too large to store' },
        413,
      ),
    ],
    [
      'the share store',
      new HarnessError(
        {
          code: 'UPSTREAM_REFUSED',
          message: 'A downstream service refused the request',
          status: 413,
        },
        502,
      ),
    ],
  ])('explains a share %s refused for its size', async (_, error) => {
    mocks.share.mockRejectedValueOnce(error)
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
        title: 'Share failed',
        description: SHARE_TOO_LARGE_MESSAGE,
        variant: 'destructive',
        position: 'top-left',
      }),
    )
  })

  it('does not show a link created for a conversation the user has left', async () => {
    const created = deferred<string>()
    mocks.share.mockReturnValueOnce(created.promise)
    const view = render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    await waitFor(() => expect(mocks.share).toHaveBeenCalledOnce())

    view.rerender(<ShareModal {...props} chatId="other-chat" />)
    await readyCheckbox()
    await act(async () => created.resolve(SHARE_URL))

    expect(
      screen.queryByRole('textbox', { name: 'Share link' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByText('Private')).toBeVisible()
    expect(mocks.status).toHaveBeenLastCalledWith('other-chat')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('requires a saved conversation before sharing', async () => {
    render(<ShareModal {...props} chatId={undefined} />)
    fireEvent.click(await readyCheckbox())
    expect(
      screen.getByRole('button', { name: 'Create share link' }),
    ).toBeDisabled()
    expect(mocks.share).not.toHaveBeenCalled()
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('only creates links when the harness cannot report or revoke shares', async () => {
    render(<ShareModal {...props} canRevoke={false} />)
    const checkbox = await readyCheckbox()
    expect(screen.getByText('Private')).toBeVisible()
    expect(
      screen.queryByText(/Disabling sharing deactivates existing links/),
    ).not.toBeInTheDocument()

    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(
      await screen.findByRole('textbox', { name: 'Share link' }),
    ).toHaveValue(SHARE_URL)
    fireEvent.click(await readyCheckbox())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(mocks.status).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
})
