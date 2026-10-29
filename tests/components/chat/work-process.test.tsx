import {
  WorkProcess,
  type WorkBlock,
} from '@/components/chat/renderers/components/WorkProcess'
import type { URLFetchState } from '@/components/chat/types'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client } from '../../harness-fixture'

const thinking = (
  id: string,
  overrides: Partial<Extract<WorkBlock, { type: 'thinking' }>> = {},
): WorkBlock => ({
  type: 'thinking',
  id,
  content: 'Considering the options carefully.',
  isThinking: false,
  duration: 4.7,
  ...overrides,
})

const search = (
  id: string,
  overrides: Partial<Extract<WorkBlock, { type: 'web_search' }>> = {},
): WorkBlock => ({
  type: 'web_search',
  id,
  state: {
    query: `query ${id}`,
    status: 'completed',
    sources: [{ title: 'Source', url: 'https://example.com/' + id }],
  },
  ...overrides,
})

const read = (
  id: string,
  statuses: URLFetchState['status'][],
  overrides: Partial<Extract<WorkBlock, { type: 'url_fetches' }>> = {},
): WorkBlock => ({
  type: 'url_fetches',
  id,
  fetches: statuses.map((status, index) => ({
    id: `${id}-${index}`,
    url: `https://${id}-${index}.example/`,
    status,
  })),
  ...overrides,
})

const longThought = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')

const renderWork = (blocks: WorkBlock[], isActive = false) =>
  render(<WorkProcess blocks={blocks} isActive={isActive} isDarkMode={false} />)

// Nested step rows keep their own (inert) buttons in the DOM, so the group
// header is always the first button.
const getHeader = () => screen.getAllByRole('button')[0]

beforeEach(() => {
  // Sources show their site's favicon, which these sites lack.
  client.post.mockImplementation(async (path: string) => {
    if (path !== '/v1/metadata/favicon')
      throw new Error(`Unexpected request: ${path}`)
    return { status: 'missing', favicon_bytes: '', favicon_content_type: '' }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkProcess once the run has finished', () => {
  it('collapses the steps behind a row naming them and expands on click', () => {
    renderWork([
      thinking('t0', { startedAt: 0, endedAt: 4_700 }),
      search('s1', { startedAt: 4_700, endedAt: 30_000 }),
      search('s2', { startedAt: 30_000, endedAt: 90_000 }),
    ])

    const header = screen.getByRole('button', {
      name: 'Thought and searched the web',
    })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    const steps = header.nextElementSibling as HTMLElement
    expect(steps).toHaveAttribute('inert')
    expect(screen.getByText('Thought')).toBeInTheDocument()
    expect(screen.getAllByText('Searched the web')).toHaveLength(2)
    expect(screen.getByText('for "query s1"')).toBeInTheDocument()

    fireEvent.click(header)

    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(steps).not.toHaveAttribute('inert')
  })

  it('expands each step in place, on its own', () => {
    renderWork([
      thinking('t0', { content: 'Plan the search.' }),
      search('s1'),
      {
        type: 'url_fetches',
        id: 'u2',
        fetches: [
          { id: 'f1', url: 'https://a.example/page', status: 'completed' },
          { id: 'f2', url: 'https://b.example/gone', status: 'failed' },
        ],
      },
    ])
    const detailsOf = (button: HTMLElement) => {
      const details = document.getElementById(
        button.getAttribute('aria-controls') ?? '',
      )
      expect(details).not.toBeNull()
      return details as HTMLElement
    }
    const header = getHeader()
    fireEvent.click(header)
    expect(detailsOf(header)).not.toHaveAttribute('inert')
    const steps = within(detailsOf(header)).getAllByRole('button')
    expect(steps.map((step) => step.textContent)).toEqual([
      'Thought for 4s',
      'Searched the web for "query s1"',
      'Read 1 link',
    ])
    const [thought, searched, read] = steps
    for (const step of steps) expect(detailsOf(step)).toHaveAttribute('inert')

    fireEvent.click(searched)

    expect(searched).toHaveAttribute('aria-expanded', 'true')
    expect(detailsOf(searched)).not.toHaveAttribute('inert')
    expect(
      within(detailsOf(searched)).getByText('Source').closest('a'),
    ).toHaveAttribute('href', 'https://example.com/s1')
    expect(thought).toHaveAttribute('aria-expanded', 'false')
    expect(detailsOf(thought)).toHaveAttribute('inert')
    expect(detailsOf(read)).toHaveAttribute('inert')

    fireEvent.click(thought)
    fireEvent.click(read)

    expect(
      within(detailsOf(thought)).getByText('Plan the search.'),
    ).toBeInTheDocument()
    expect(detailsOf(read)).not.toHaveAttribute('inert')
    expect(
      within(detailsOf(read)).getByText('b.example/gone'),
    ).toBeInTheDocument()
    expect(searched).toHaveAttribute('aria-expanded', 'true')
  })

  it.each<{ blocks: WorkBlock[]; label: string }>([
    {
      blocks: [
        thinking('t0'),
        search('s1'),
        read('r2', ['completed', 'completed', 'completed']),
      ],
      label: 'Thought, searched the web, and read 3 pages',
    },
    {
      blocks: [search('s0'), read('r1', ['completed', 'failed'])],
      label: 'Searched the web and read a page',
    },
    {
      blocks: [thinking('t0'), search('s1'), thinking('t2'), search('s3')],
      label: 'Thought and searched the web',
    },
    {
      blocks: [
        read('r0', ['completed', 'completed']),
        thinking('t1'),
        read('r2', ['completed']),
      ],
      label: 'Read 3 pages and thought',
    },
    {
      blocks: [thinking('t0'), read('r1', ['failed', 'failed'])],
      label: 'Thought and tried to read 2 pages',
    },
    { blocks: [search('s0'), search('s1')], label: 'Searched the web' },
  ])('names what its steps did: $label', ({ blocks, label }) => {
    renderWork(blocks)
    expect(getHeader()).toHaveTextContent(new RegExp(`^${label}$`))
  })
})

describe('WorkProcess while the run is active', () => {
  it('shows the in-flight search instead of a duration', () => {
    const { container } = renderWork(
      [
        thinking('t0'),
        search('s1', {
          state: { query: 'latest news', status: 'searching' },
        }),
      ],
      true,
    )
    const header = getHeader()
    expect(header).toHaveTextContent('Searching the web for "latest news"')
    expect(container).not.toHaveTextContent(/Worked/)
  })

  it('shows the running URL fetch label', () => {
    renderWork(
      [
        search('s0'),
        {
          type: 'url_fetches',
          id: 'u1',
          fetches: [
            { id: 'f1', url: 'https://a.example', status: 'completed' },
            { id: 'f2', url: 'https://b.example', status: 'fetching' },
          ],
        },
      ],
      true,
    )
    expect(getHeader()).toHaveTextContent('Reading 2 links')
  })

  it('shows "Working" between steps, timed from when it first showed without a start', () => {
    vi.useFakeTimers()
    renderWork([thinking('t0'), search('s1')], true)
    expect(getHeader()).toHaveAccessibleName('Working 0s')

    act(() => vi.advanceTimersByTime(3_000))

    expect(getHeader()).toHaveAccessibleName('Working 3s')
  })

  it("shows the active thought's summary in the header and in its step", () => {
    renderWork(
      [
        search('s0'),
        thinking('t1', {
          content: longThought,
          isThinking: true,
          summary: 'Weighing the tradeoffs',
        }),
      ],
      true,
    )

    expect(getHeader()).toHaveTextContent('Weighing the tradeoffs')
    expect(screen.getAllByText('Weighing the tradeoffs')).toHaveLength(2)
  })

  it('times the run from its first start and each step from its own, until they end', () => {
    vi.useFakeTimers({ now: 10_000 })
    const { rerender } = renderWork(
      [
        thinking('t0', { startedAt: 2_000, endedAt: 4_000 }),
        search('s1', {
          startedAt: 4_000,
          state: { query: 'q', status: 'searching' },
        }),
      ],
      true,
    )
    const header = getHeader()
    const step = screen.getByRole('button', {
      name: 'Searching the web for "q" 6s',
    })
    expect(header).toHaveAccessibleName('Searching the web for "q" 8s')

    act(() => vi.advanceTimersByTime(53_000))

    expect(header).toHaveAccessibleName('Searching the web for "q" 1m 1s')
    expect(step).toHaveAccessibleName('Searching the web for "q" 59s')

    rerender(
      <WorkProcess
        blocks={[
          thinking('t0', { startedAt: 2_000, endedAt: 4_000 }),
          search('s1', { startedAt: 4_000, endedAt: 63_000 }),
        ]}
        isActive={false}
        isDarkMode={false}
      />,
    )

    expect(header).toHaveAccessibleName('Thought and searched the web')
    expect(step).toHaveAccessibleName('Searched the web for "query s1"')
    expect(vi.getTimerCount()).toBe(0)
  })
})
