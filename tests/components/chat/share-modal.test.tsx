import { ShareModal } from '@/components/chat/share-modal'
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
  getShareStatus: vi.fn(),
  deleteSharedChat: vi.fn(),
  uploadSharedChat: vi.fn(),
  shareSeal: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/services/share-api', () => mocks)
vi.mock('@/services/sync-enclave/sync-api', () => ({
  shareSeal: mocks.shareSeal,
}))
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

const props = {
  isOpen: true,
  onClose: vi.fn(),
  messages: [],
  isDarkMode: false,
  chatId: 'chat-id',
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
  const checkbox = screen.getByRole('checkbox')
  await waitFor(() => expect(checkbox).toBeEnabled())
  return checkbox
}

describe('ShareModal revocation', () => {
  let shared: boolean

  beforeEach(() => {
    vi.resetAllMocks()
    shared = false
    mocks.getShareStatus.mockImplementation(async () => shared)
    mocks.deleteSharedChat.mockImplementation(async () => {
      shared = false
    })
    mocks.uploadSharedChat.mockImplementation(async () => {
      shared = true
    })
    mocks.shareSeal.mockResolvedValue({
      share_key: 'ab'.repeat(32),
      ciphertext: 'AQID',
    })
  })

  afterEach(cleanup)

  it('preserves encrypted upload bytes and conversation markdown', async () => {
    render(
      <ShareModal
        {...props}
        messages={[{ role: 'user', content: 'Hello', timestamp: new Date(0) }]}
      />,
    )
    expect(
      screen.getByLabelText('Raw conversation markdown'),
    ).toHaveTextContent('## User Hello ---')
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(
      await screen.findByRole('textbox', { name: 'Share link' }),
    ).toHaveValue(
      `${window.location.origin}/share/chat-id#v2:${'ab'.repeat(32)}`,
    )
    expect(mocks.uploadSharedChat).toHaveBeenCalledWith(
      'chat-id',
      new Uint8Array([1, 2, 3]),
    )
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveFocus(),
    )
  })

  it('revokes a created link, clears it, and requires a fresh link when reenabled', async () => {
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(
      await screen.findByRole('textbox', { name: 'Share link' }),
    ).toHaveValue(
      `${window.location.origin}/share/chat-id#v2:${'ab'.repeat(32)}`,
    )

    const deletion = deferred<void>()
    mocks.deleteSharedChat.mockImplementationOnce(async () => {
      await deletion.promise
      shared = false
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
    expect(mocks.deleteSharedChat).toHaveBeenCalledWith('chat-id')

    await act(async () => deletion.resolve())
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
    mocks.shareSeal.mockResolvedValue({
      share_key: 'cd'.repeat(32),
      ciphertext: 'BAUG',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(
      await screen.findByRole('textbox', { name: 'Share link' }),
    ).toHaveValue(
      `${window.location.origin}/share/chat-id#v2:${'cd'.repeat(32)}`,
    )
    expect(mocks.uploadSharedChat).toHaveBeenLastCalledWith(
      'chat-id',
      new Uint8Array([4, 5, 6]),
    )
    expect(mocks.getShareStatus).toHaveBeenCalledTimes(1)
  })

  it('cancels sharing locally when no link has been created', async () => {
    mocks.deleteSharedChat.mockRejectedValue(new Error('Offline'))
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('checkbox')).toBeEnabled()
    expect(screen.getByText('Private')).toBeVisible()
    expect(mocks.deleteSharedChat).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('does not show stale enabled controls while reopened status is unknown', async () => {
    shared = true
    const view = render(<ShareModal {...props} />)
    expect(await readyCheckbox()).toBeChecked()
    view.rerender(<ShareModal {...props} isOpen={false} />)
    const status = deferred<boolean>()
    mocks.getShareStatus.mockReturnValueOnce(status.promise)
    view.rerender(<ShareModal {...props} />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(
      screen.queryByRole('button', { name: 'Create share link' }),
    ).not.toBeInTheDocument()
    await act(async () => status.reject(new Error('Offline')))
    expect(screen.getByText('Share status unavailable')).toBeVisible()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry share status' }))
    expect(await readyCheckbox()).toBeChecked()
  })

  it('discovers an existing share after remount and revokes without the original key', async () => {
    shared = true
    const view = render(<ShareModal {...props} />)
    expect(await readyCheckbox()).toBeChecked()
    expect(screen.getByText(/An existing link is active/)).toBeVisible()
    view.unmount()

    render(<ShareModal {...props} />)
    expect(await readyCheckbox()).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByText('Private')).toBeVisible()
    expect(shared).toBe(false)
    expect(mocks.deleteSharedChat).toHaveBeenCalledWith('chat-id')
    expect(mocks.shareSeal).not.toHaveBeenCalled()
  })

  it('keeps sharing enabled on deletion failure and allows retry', async () => {
    shared = true
    mocks.deleteSharedChat.mockRejectedValueOnce(new Error('Offline'))
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Could not disable sharing',
        }),
      ),
    )
    expect(await readyCheckbox()).toBeChecked()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
    expect(shared).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByText('Private')).toBeVisible()
    expect(shared).toBe(false)
  })

  it('does not claim privacy when status fails and can retry', async () => {
    shared = true
    mocks.getShareStatus.mockRejectedValueOnce(new Error('Offline'))
    render(<ShareModal {...props} />)
    expect(await screen.findByText('Share status unavailable')).toBeVisible()
    expect(screen.queryByText('Private')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry share status' }))
    expect(await readyCheckbox()).toBeChecked()
  })

  it('blocks revocation until an in-flight upload completes', async () => {
    const upload = deferred<void>()
    mocks.uploadSharedChat.mockImplementationOnce(async () => {
      await upload.promise
      shared = true
    })
    render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    await waitFor(() => expect(mocks.uploadSharedChat).toHaveBeenCalled())
    expect(screen.getByRole('checkbox')).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(mocks.deleteSharedChat).not.toHaveBeenCalled()
    await act(async () => upload.resolve())
    expect(await readyCheckbox()).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByText('Private')).toBeVisible()
  })

  it('rechecks server state after an upload succeeds but its response is lost', async () => {
    mocks.uploadSharedChat.mockImplementationOnce(async () => {
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
  })

  it('refreshes status when reopened after another device revokes the share', async () => {
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
    const status = deferred<boolean>()
    mocks.getShareStatus.mockReturnValueOnce(status.promise)
    const view = render(<ShareModal {...props} />)
    view.rerender(<ShareModal {...props} isOpen={false} />)
    view.rerender(<ShareModal {...props} />)
    expect(await readyCheckbox()).not.toBeChecked()
    await act(async () => status.resolve(true))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByText('Private')).toBeVisible()
  })

  it('does not publish an abandoned conversation after sealing completes', async () => {
    const seal = deferred<{ share_key: string; ciphertext: string }>()
    mocks.shareSeal.mockReturnValueOnce(seal.promise)
    const view = render(<ShareModal {...props} />)
    fireEvent.click(await readyCheckbox())
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    view.rerender(<ShareModal {...props} chatId="other-chat" />)
    await readyCheckbox()
    await act(async () =>
      seal.resolve({ share_key: 'ab'.repeat(32), ciphertext: 'AQID' }),
    )
    expect(mocks.uploadSharedChat).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})
