import { ConnectorsSettings } from '@/components/chat/connectors-settings'
import { HarnessError } from '@/services/harness/sse'
import type { Connector } from '@/services/harness/types'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { client, KEY, signIn, testSession } from '../../harness-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const session = {
  ...testSession,
  features: { ...testSession.features, connectors: true },
}

// The first server the catalog lists, whatever it holds.
const [listed] = JSON.parse(
  readFileSync('src/constants/connector-catalog.json', 'utf8'),
) as { name: string; url: string }[]

const connector = (fields: Partial<Connector> = {}): Connector => ({
  id: 'connector-1',
  name: 'Docs',
  url: 'https://mcp.docs.example/mcp',
  enabled: true,
  status: 'connected',
  signIn: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  tools: [],
  ...fields,
})

let connectors: Connector[]
let answer: (path: string, input: Record<string, unknown>) => Promise<unknown>

beforeEach(() => {
  connectors = []
  answer = async (path) => {
    throw new Error(`Unexpected harness request: ${path}`)
  }
  signIn({ cloud: true, session })
  client.post.mockImplementation(
    async (path: string, input: Record<string, unknown>) =>
      path === '/v1/session'
        ? structuredClone(session)
        : path === '/v1/connectors/list'
          ? { connectors: structuredClone(connectors) }
          : answer(path, input),
  )
})

const requests = (path: string) =>
  client.post.mock.calls.filter(([called]) => called === path)

describe('the Connectors settings', () => {
  it('connects a server the catalog lists and shows it as added', async () => {
    answer = async (path) => {
      if (path !== '/v1/connectors/add')
        throw new Error(`Unexpected harness request: ${path}`)
      return {
        connector: connector({ name: listed.name, url: listed.url }),
      }
    }
    render(<ConnectorsSettings isDarkMode={false} />)

    fireEvent.click(
      await screen.findByRole('button', { name: `Connect ${listed.name}` }),
    )

    const yours = await screen.findByRole('list', { name: 'Your connectors' })
    expect(within(yours).getByText(listed.name)).toBeInTheDocument()
    expect(requests('/v1/connectors/add')).toEqual([
      [
        '/v1/connectors/add',
        { key: KEY, name: listed.name, url: listed.url },
        expect.any(AbortSignal),
      ],
    ])
    const catalog = screen.getByRole('list', {
      name: 'Connectors you can add',
    })
    expect(
      within(catalog).queryByRole('button', { name: `Connect ${listed.name}` }),
    ).toBeNull()
    expect(within(catalog).getByText('Added')).toBeInTheDocument()
  })

  it("shows a tool's permission at once, and takes it back when refused", async () => {
    connectors = [
      connector({
        tools: [
          { name: 'create_page', title: 'Create a page', permission: 'ask' },
        ],
      }),
    ]
    let refuse!: (cause: unknown) => void
    answer = (path) => {
      if (path !== '/v1/connectors/update')
        throw new Error(`Unexpected harness request: ${path}`)
      return new Promise((_, reject) => {
        refuse = reject
      })
    }
    render(<ConnectorsSettings isDarkMode={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Docs details' }))
    const permission = screen.getByRole('radiogroup', { name: 'Create a page' })
    expect(
      within(permission).getByRole('radio', { name: 'Ask first' }),
    ).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(
      within(permission).getByRole('radio', { name: 'Always allow' }),
    )

    expect(
      within(permission).getByRole('radio', { name: 'Always allow' }),
    ).toHaveAttribute('aria-checked', 'true')
    await waitFor(() =>
      expect(requests('/v1/connectors/update')).toEqual([
        [
          '/v1/connectors/update',
          { key: KEY, id: 'connector-1', tools: { create_page: 'allow' } },
          expect.any(AbortSignal),
        ],
      ]),
    )

    await act(async () =>
      refuse(
        new HarnessError({
          code: 'REVISION_CONFLICT',
          action: 'reload',
          message: 'The connector no longer offers this tool',
        }),
      ),
    )

    expect(
      within(permission).getByRole('radio', { name: 'Ask first' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
