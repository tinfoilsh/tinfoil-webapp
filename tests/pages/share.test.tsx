import SharePage from '@/components/share/share-page'
import { harnessAPI } from '@/services/harness/runtime'
import { HarnessError } from '@/services/harness/sse'
import type { SharedThread } from '@/services/harness/types'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  shareOpen: vi.fn<(input: unknown) => Promise<SharedThread>>(),
  sharedChatView: vi.fn(),
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

const thread: SharedThread = {
  title: 'Shared chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Hello',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
}

const VALID_SHARE_KEY = 'ab'.repeat(32)
let originalHash = ''

describe('SharePage', () => {
  beforeEach(() => {
    originalHash = window.location.hash
    window.location.hash = ''
    mocks.sharedChatView.mockReset()
    mocks.shareOpen.mockReset().mockResolvedValue(thread)
    vi.mocked(harnessAPI().client.post).mockImplementation(
      async (path: string, input: unknown) => {
        if (path !== '/v1/shares/open')
          throw new Error(`Unexpected request: ${path}`)
        return mocks.shareOpen(input)
      },
    )
  })

  afterEach(() => {
    window.location.hash = originalHash
  })

  it('opens a v2 link through the harness without sending an account key', async () => {
    window.location.hash = `#v2:${VALID_SHARE_KEY}`

    render(<SharePage chatId="chat-id" />)

    expect(await screen.findByText('Rendered shared chat')).toBeInTheDocument()
    expect(mocks.shareOpen).toHaveBeenCalledExactlyOnceWith({
      shareId: 'chat-id',
      fragment: `v2:${VALID_SHARE_KEY}`,
    })
    expect(
      Object.keys(mocks.shareOpen.mock.calls[0][0] as object).sort(),
    ).toEqual(['fragment', 'shareId'])
    expect(
      screen.getByRole('heading', { level: 1, name: 'Shared chat' }),
    ).toBeVisible()
    expect(mocks.sharedChatView).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatData: thread }),
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

    render(<SharePage chatId="chat-id" />)

    expect(
      await screen.findByRole('heading', { name: 'Unsupported Share Link' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/ask the sender to create a new link/i),
    ).toBeVisible()
    expect(mocks.shareOpen).not.toHaveBeenCalled()
  })

  it.each([
    {
      error: new HarnessError(
        {
          code: 'THREAD_NOT_FOUND',
          message: 'The requested data was not found',
        },
        404,
      ),
      message: 'This shared chat does not exist or has been deleted',
    },
    {
      error: new HarnessError(
        { code: 'BAD_REQUEST', message: 'Invalid shared thread' },
        400,
      ),
      message: 'Failed to load shared chat',
    },
  ])(
    'does not render a share the harness refuses: $message',
    async ({ error, message }) => {
      window.location.hash = `#v2:${VALID_SHARE_KEY}`
      mocks.shareOpen.mockRejectedValueOnce(error)

      render(<SharePage chatId="chat-id" />)

      expect(
        await screen.findByRole('heading', { name: 'Invalid Share Link' }),
      ).toBeVisible()
      expect(screen.getByText(message)).toBeVisible()
      expect(mocks.sharedChatView).not.toHaveBeenCalled()
    },
  )
})
