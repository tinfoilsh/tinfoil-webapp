import { ChatInterface } from '@/components/chat/chat-interface'
import { MAX_CONCURRENT_IMAGE_LOADS } from '@/components/chat/image-gallery-context'
import { ProjectProvider } from '@/components/project/project-provider'
import { HarnessError } from '@/services/harness/sse'
import type { AttachmentDescriptor } from '@/services/harness/types'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import {
  resetChatStoresAroundEachTest,
  storedThread,
} from '../../services/harness/thread-fixture'
import { refuseFetch } from './chat-interface-fixture'
import { chatPage } from './chat-page-mocks'

vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
vi.mock('next/router', async () => (await import('./chat-page-mocks')).router)
vi.mock('next/head', async () => (await import('./chat-page-mocks')).head)
vi.mock('next/dynamic', async () => (await import('./chat-page-mocks')).dynamic)
vi.mock(
  '@/components/ui/logo-loading',
  async () => (await import('./chat-page-mocks')).logoLoading,
)
vi.mock(
  '@/hooks/use-subscription-status',
  async () => (await import('./chat-page-mocks')).subscription,
)
vi.mock(
  '@/hooks/use-passkey-backup',
  async () => (await import('./chat-page-mocks')).passkeyBackup,
)
vi.mock('@/components/chat/sidebar-account-menu', () => ({
  SidebarAccountMenu: () => null,
}))
vi.mock('@/hooks/use-upgrade-to-pro', () => ({
  useUpgradeToPro: () => ({ startUpgrade: vi.fn() }),
}))
vi.mock(
  '@/utils/error-handling',
  async () => (await import('./chat-page-mocks')).errorHandling,
)

resetChatStoresAroundEachTest()

const CHAT_ID = 'imported-chat'
const SUNSET = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  chatPage.auth = { isLoaded: true, isSignedIn: true, userId: 'alice' }
  chatPage.premium = false
  chatPage.router.pathname = '/'
  chatPage.router.query = {}
  chatPage.router.asPath = '/'
  chatPage.router.replace.mockReset().mockResolvedValue(true)
  chatPage.router.push.mockReset().mockResolvedValue(true)
  refuseFetch()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) =>
    blob === SUNSET ? 'blob:sunset' : 'blob:other',
  )
})

const image = (
  id: string,
  fileName: string,
  fields: Partial<AttachmentDescriptor> = {},
): AttachmentDescriptor => ({
  id,
  kind: 'image',
  fileName,
  mimeType: 'image/jpeg',
  size: 3,
  ...fields,
})

// Opens a stored chat whose question carries `attachments`, and returns the
// attachment downloads it asks for, each answered when the test says. Like
// a fetch, a download fails once its signal aborts.
function openChat(attachments: AttachmentDescriptor[]) {
  signIn({ cloud: true })
  const downloads: {
    input: unknown
    finish: (blob: Blob) => void
    fail: (error: unknown) => void
  }[] = []
  client.download.mockImplementation(
    (path: string, input: unknown, signal?: AbortSignal) => {
      if (path !== '/v1/attachments/get') throw new Error(`Unexpected ${path}`)
      return new Promise<Blob>((resolve, reject) => {
        downloads.push({ input, finish: resolve, fail: reject })
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    },
  )
  client.post.mockImplementation(async (path: string) => {
    if (path === '/v1/projects/list') return { projects: [], nextCursor: null }
    if (path === '/v1/threads/list') return { threads: [], nextCursor: null }
    if (path === '/v1/threads/get')
      return {
        ...storedThread(CHAT_ID, {
          title: 'Imported chat',
          messages: [
            {
              id: 'u1',
              role: 'user',
              createdAt: '2026-10-22T12:00:00Z',
              content: 'Look at these',
              attachments,
            },
            {
              id: 'a1',
              role: 'assistant',
              createdAt: '2026-10-22T12:00:30Z',
              content: 'Lovely',
              timeline: [{ id: 'b1', type: 'content', content: 'Lovely' }],
            },
          ],
        }),
        titleState: 'generated',
        messageCount: 2,
        hasOlder: false,
      }
    throw new Error(`Unexpected ${path}`)
  })
  render(
    <ProjectProvider>
      <ChatInterface suppressIntroModals initialChatId={CHAT_ID} />
    </ProjectProvider>,
  )
  return downloads
}

// The images of the gallery's current slide, without those of the inert
// slides it keeps around it.
const shownInGallery = () =>
  within(screen.getByRole('region', { name: 'Photo gallery' }))
    .queryAllByRole('img')
    .filter((img) => !img.closest('[inert]'))
    .map((img) => ({
      alt: img.getAttribute('alt'),
      src: img.getAttribute('src'),
    }))

const download = (id: string) => [
  '/v1/attachments/get',
  { key: KEY, id, threadId: CHAT_ID },
  expect.any(AbortSignal),
]

it('shows a stored image without a thumbnail once its full copy loads', async () => {
  const downloads = openChat([image('att_sunset', 'sunset.jpg')])

  const tile = await screen.findByRole('button', {
    name: 'View image sunset.jpg',
  })
  expect(tile).toHaveAttribute('aria-busy', 'true')
  await waitFor(() => expect(downloads).toHaveLength(1))
  expect(client.download).toHaveBeenCalledExactlyOnceWith(
    ...download('att_sunset'),
  )

  await act(async () => downloads[0].finish(SUNSET))

  expect(within(tile).getByRole('img', { name: 'sunset.jpg' })).toHaveAttribute(
    'src',
    'blob:sunset',
  )
  expect(tile).not.toHaveAttribute('aria-busy')
})

it('loads no full copy of a stored image that has a thumbnail', async () => {
  const downloads = openChat([
    image('att_chart', 'chart.png', { thumbnail: 'dGh1bWI=' }),
    image('att_sunset', 'sunset.jpg'),
  ])

  expect(await screen.findByRole('img', { name: 'chart.png' })).toHaveAttribute(
    'src',
    'data:image/jpeg;base64,dGh1bWI=',
  )
  await waitFor(() => expect(downloads).toHaveLength(1))
  expect(client.download).toHaveBeenCalledExactlyOnceWith(
    ...download('att_sunset'),
  )
})

it('opens a stored image without a thumbnail in the gallery while it loads', async () => {
  const downloads = openChat([image('att_sunset', 'sunset.jpg')])

  fireEvent.click(
    await screen.findByRole('button', { name: 'View image sunset.jpg' }),
  )
  await screen.findByRole('region', { name: 'Photo gallery' })
  expect(shownInGallery()).toEqual([])

  await act(async () => downloads[0].finish(SUNSET))

  expect(shownInGallery()).toEqual([{ alt: 'sunset.jpg', src: 'blob:sunset' }])
  expect(client.download).toHaveBeenCalledExactlyOnceWith(
    ...download('att_sunset'),
  )
})

it('shows a stored image that failed to load as failed, and tries it again in the gallery', async () => {
  const downloads = openChat([image('att_sunset', 'sunset.jpg')])
  await waitFor(() => expect(downloads).toHaveLength(1))

  await act(async () =>
    downloads[0].fail(
      new HarnessError(
        {
          code: 'THREAD_NOT_FOUND',
          message: 'The attachment was not found',
          action: 'stop',
        },
        404,
      ),
    ),
  )

  const tile = screen.getByRole('button', {
    name: 'Image sunset.jpg could not be loaded',
  })
  expect(tile).not.toHaveAttribute('aria-busy')
  expect(tile.querySelector('.animate-spin')).toBeNull()

  fireEvent.click(tile)
  await waitFor(() => expect(downloads).toHaveLength(2))
  expect(client.download).toHaveBeenLastCalledWith(...download('att_sunset'))
  await act(async () => downloads[1].finish(SUNSET))

  expect(shownInGallery()).toEqual([{ alt: 'sunset.jpg', src: 'blob:sunset' }])
})

it('loads a few stored images at a time, the one the gallery opens first', async () => {
  const ids = Array.from(
    { length: MAX_CONCURRENT_IMAGE_LOADS + 2 },
    (_, n) => `att_${n}`,
  )
  const downloads = openChat(ids.map((id) => image(id, `${id}.jpg`)))
  await waitFor(() =>
    expect(downloads).toHaveLength(MAX_CONCURRENT_IMAGE_LOADS),
  )
  expect(downloads.map(({ input }) => input)).toEqual(
    ids
      .slice(0, MAX_CONCURRENT_IMAGE_LOADS)
      .map((id) => ({ key: KEY, id, threadId: CHAT_ID })),
  )
  const last = ids.at(-1)!

  fireEvent.click(
    screen.getByRole('button', { name: `View image ${last}.jpg` }),
  )
  await act(async () => downloads[0].finish(new Blob(['first'])))

  await waitFor(() =>
    expect(downloads).toHaveLength(MAX_CONCURRENT_IMAGE_LOADS + 1),
  )
  expect(downloads.at(-1)!.input).toEqual({
    key: KEY,
    id: last,
    threadId: CHAT_ID,
  })
})
