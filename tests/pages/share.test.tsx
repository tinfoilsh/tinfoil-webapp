import SharePage from '@/pages/share/[[...slug]]'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchSharedChat: vi.fn(),
  shareOpen: vi.fn(),
  sharedChatView: vi.fn(),
  router: {
    isReady: true,
    query: { slug: ['chat-id'] } as Record<
      string,
      string | string[] | undefined
    >,
  },
}))

vi.mock('next/router', () => ({
  useRouter: () => mocks.router,
}))

vi.mock('next/head', () => ({
  default: () => null,
}))

vi.mock('@/components/chat/renderers/client', () => ({
  initializeRenderers: vi.fn(),
}))

vi.mock('@/components/chat/shared-chat-view', () => ({
  SharedChatView: (props: Record<string, unknown>) => {
    mocks.sharedChatView(props)
    return <div>Rendered shared chat</div>
  },
}))

vi.mock('@/config/models', () => ({
  getAIModels: vi.fn().mockResolvedValue([{ id: 'model', type: 'chat' }]),
}))

vi.mock('@/services/share-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/share-api')>()
  return { ...original, fetchSharedChat: mocks.fetchSharedChat }
})

vi.mock('@/services/sync-enclave/sync-api', () => ({
  shareOpen: mocks.shareOpen,
}))

const payload = {
  v: 1,
  title: 'Shared chat',
  messages: [{ role: 'user', content: 'Hello', timestamp: 1 }],
  createdAt: 1,
}

const VALID_SHARE_KEY = 'ab'.repeat(32)
const CIPHERTEXT = new Uint8Array([1, 2, 3])
let originalHash = ''

describe('SharePage', () => {
  beforeEach(() => {
    originalHash = window.location.hash
    window.location.hash = ''
    vi.clearAllMocks()
    mocks.router.isReady = true
    mocks.router.query = { slug: ['chat-id'] }
    mocks.fetchSharedChat.mockResolvedValue({
      formatVersion: 1,
      binary: CIPHERTEXT.buffer,
    })
    mocks.shareOpen.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(payload)),
    )
  })

  afterEach(() => {
    window.location.hash = originalHash
  })

  it('opens a v2 link through the enclave', async () => {
    const shareKey = VALID_SHARE_KEY
    window.location.hash = `#v2:${shareKey}`

    render(<SharePage />)

    expect(await screen.findByText('Rendered shared chat')).toBeInTheDocument()
    expect(mocks.fetchSharedChat).toHaveBeenCalledWith('chat-id')
    expect(mocks.shareOpen).toHaveBeenCalledWith({
      shareKeyHex: shareKey,
      ciphertext: CIPHERTEXT,
    })
    expect(mocks.sharedChatView).toHaveBeenCalledWith(
      expect.objectContaining({ chatData: payload }),
    )
  })

  it.each([
    ['', 'a missing fragment'],
    ['#legacyBase64UrlKey', 'an unprefixed fragment'],
    [`#v1:${VALID_SHARE_KEY}`, 'a v1 marker'],
    [`#v2:${VALID_SHARE_KEY.toUpperCase()}`, 'uppercase hexadecimal'],
    [`#v2:${VALID_SHARE_KEY.slice(2)}`, 'a short key'],
    [`#v2:${VALID_SHARE_KEY}extra`, 'a key with trailing data'],
  ])('rejects %s as unsupported (%s)', async (hash) => {
    window.location.hash = hash

    render(<SharePage />)

    expect(
      await screen.findByRole('heading', { name: 'Unsupported Share Link' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/ask the sender to create a new link/i),
    ).toBeVisible()
    expect(mocks.fetchSharedChat).not.toHaveBeenCalled()
  })

  it('shows unsupported-link UI for legacy storage format 0', async () => {
    window.location.hash = `#v2:${VALID_SHARE_KEY}`
    const { UnsupportedShareFormatError } = await import('@/services/share-api')
    mocks.fetchSharedChat.mockRejectedValue(
      new UnsupportedShareFormatError('Unsupported share storage format'),
    )

    await act(async () => {
      render(<SharePage />)
    })

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Unsupported Share Link' }),
      ).toBeInTheDocument(),
    )
    expect(mocks.shareOpen).not.toHaveBeenCalled()
  })

  it('does not decrypt or render a revoked share', async () => {
    window.location.hash = `#v2:${VALID_SHARE_KEY}`
    const { SharedChatNotFoundError } = await import('@/services/share-api')
    mocks.fetchSharedChat.mockRejectedValue(new SharedChatNotFoundError())
    render(<SharePage />)
    expect(
      await screen.findByRole('heading', { name: 'Invalid Share Link' }),
    ).toBeVisible()
    expect(
      screen.getByText('This shared chat does not exist or has been deleted'),
    ).toBeVisible()
    expect(mocks.shareOpen).not.toHaveBeenCalled()
    expect(mocks.sharedChatView).not.toHaveBeenCalled()
  })
})
