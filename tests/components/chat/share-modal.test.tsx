import { ShareModal } from '@/components/chat/share-modal'
import { harnessAPI } from '@/services/harness/runtime'
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
  share: vi.fn<(input: unknown) => Promise<{ url: string }>>(),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))
vi.mock('@tinfoilsh/tinfoil-icons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tinfoilsh/tinfoil-icons')>()),
  TfGlobe: () => <svg data-testid="globe-icon" />,
  TfLockLocked: () => <svg data-testid="lock-icon" />,
}))

const SHARE_URL = 'https://chat.tinfoil.sh/share/chat-id#key'
const props = {
  isOpen: true,
  onClose: vi.fn(),
  messages: [],
  isDarkMode: false,
  chatId: 'chat-id',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function enableSharing() {
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'Make this conversation shareable with anyone who has the link',
    }),
  )
}

beforeEach(() => {
  mocks.toast.mockReset()
  mocks.share.mockReset().mockResolvedValue({ url: SHARE_URL })
  props.onClose.mockReset()
  vi.mocked(harnessAPI().client.post).mockImplementation(
    async (path: string, input: unknown) => {
      if (path !== '/v1/threads/share')
        throw new Error(`Unexpected request: ${path}`)
      return mocks.share(input)
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

  it('creates a share link through the harness and focuses it', async () => {
    render(<ShareModal {...props} />)
    expect(screen.getByText('Private')).toBeVisible()
    expect(screen.getByTestId('lock-icon')).toBeInTheDocument()

    enableSharing()
    expect(screen.getByText('Shareable link access')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))

    const link = await screen.findByRole('textbox', { name: 'Share link' })
    expect(link).toHaveValue(SHARE_URL)
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith({ threadId: 'chat-id' })
    expect(screen.getByRole('status')).toHaveTextContent('Share link ready')
    expect(screen.getByTestId('globe-icon')).toBeInTheDocument()
    await waitFor(() => expect(link).toHaveFocus())
  })

  it('reports a refused share without showing a link', async () => {
    mocks.share.mockRejectedValueOnce(
      new HarnessError(
        { code: 'UPSTREAM_REFUSED', message: 'The chat could not be shared' },
        502,
      ),
    )
    render(<ShareModal {...props} />)
    enableSharing()
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
    expect(
      screen.getByRole('button', { name: 'Create share link' }),
    ).toBeEnabled()
  })

  it('does not show a link created for a conversation the user has left', async () => {
    const share = deferred<{ url: string }>()
    mocks.share.mockReturnValueOnce(share.promise)
    const view = render(<ShareModal {...props} />)
    enableSharing()
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    await waitFor(() => expect(mocks.share).toHaveBeenCalledOnce())

    view.rerender(<ShareModal {...props} chatId="other-chat" />)
    await act(async () => share.resolve({ url: SHARE_URL }))

    expect(
      screen.queryByRole('textbox', { name: 'Share link' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByText('Private')).toBeVisible()
    enableSharing()
    expect(
      screen.getByRole('button', { name: 'Create share link' }),
    ).toBeEnabled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('requires a saved conversation before sharing', () => {
    render(<ShareModal {...props} chatId={undefined} />)
    enableSharing()
    expect(
      screen.getByRole('button', { name: 'Create share link' }),
    ).toBeDisabled()
    expect(mocks.share).not.toHaveBeenCalled()
  })
})
