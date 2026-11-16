import { ChatInput } from '@/components/chat/chat-input'
import type { Connector } from '@/services/harness/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'

vi.mock('@/components/project', () => ({
  ProjectModeBanner: () => null,
  useProject: () => ({
    isProjectMode: false,
    activeProject: null,
    loadingProject: false,
  }),
}))
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}))
vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  CHAT_FONT_CLASSES: { default: '' },
  useChatFont: () => 'default',
}))

const session = {
  ...testSession,
  features: { ...testSession.features, connectors: true },
}

const NOTION: Connector = {
  id: 'connector-1',
  name: 'Notion',
  url: 'https://mcp.notion.com/mcp',
  enabled: true,
  status: 'connected',
  signIn: true,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  tools: [],
}

beforeEach(() => {
  signIn({ cloud: true, session })
  client.post.mockImplementation(async (path: string) => {
    switch (path) {
      case '/v1/session':
        return structuredClone(session)
      case '/v1/connectors/list':
        return { connectors: [structuredClone(NOTION)] }
      case '/v1/connectors/update':
        return { connector: { ...NOTION, enabled: false } }
      default:
        throw new Error(`Unexpected harness request: ${path}`)
    }
  })
})

function renderComposer(available: boolean) {
  render(
    <ChatInput
      chatId="chat-1"
      input=""
      setInput={vi.fn()}
      handleSubmit={vi.fn()}
      loadingState="idle"
      cancelGeneration={vi.fn()}
      inputRef={createRef<HTMLTextAreaElement>()}
      handleInputFocus={vi.fn()}
      inputMinHeight="40px"
      isDarkMode={false}
      connectors={{ available, onManage: vi.fn() }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Input options' }))
}

const updates = () =>
  client.post.mock.calls.filter(([path]) => path === '/v1/connectors/update')

describe('the composer’s connectors', () => {
  it('turns a connector off for chats from the input options', async () => {
    renderComposer(true)
    const notion = await screen.findByRole('menuitemcheckbox', {
      name: 'Notion',
    })
    expect(notion).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(notion)

    expect(notion).toHaveAttribute('aria-checked', 'false')
    await waitFor(() =>
      expect(updates()).toEqual([
        [
          '/v1/connectors/update',
          { key: KEY, id: 'connector-1', enabled: false },
          expect.any(AbortSignal),
        ],
      ]),
    )
  })

  it('changes nothing in a chat that does not run connectors', async () => {
    renderComposer(false)
    const notion = await screen.findByRole('menuitemcheckbox', {
      name: 'Notion',
    })

    fireEvent.click(notion)

    expect(notion).toHaveAttribute('aria-checked', 'true')
    expect(updates()).toEqual([])
    expect(
      screen.getByText('Connectors work only in chats saved to the cloud.'),
    ).toBeInTheDocument()
  })
})
