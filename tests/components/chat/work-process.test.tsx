import {
  WorkProcess,
  getWorkDurationSeconds,
  type WorkBlock,
} from '@/components/chat/renderers/components/WorkProcess'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const summarize = vi.hoisted(() => vi.fn())
vi.mock('@/services/inference/summary-client', () => ({ summarize }))

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

const renderWork = (blocks: WorkBlock[], isActive = false) =>
  render(<WorkProcess blocks={blocks} isActive={isActive} isDarkMode={false} />)

// Nested step rows keep their own (inert) buttons in the DOM, so the group
// header is always the first button.
const getHeader = () => screen.getAllByRole('button')[0]

beforeEach(() => {
  summarize.mockReset()
  summarize.mockResolvedValue('')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getWorkDurationSeconds', () => {
  it('spans the run wall-clock rather than summing overlapping steps', () => {
    expect(
      getWorkDurationSeconds([
        thinking('t', { startedAt: 1_000, endedAt: 5_000, duration: 4 }),
        search('a', { startedAt: 5_000, endedAt: 20_000 }),
        search('b', { startedAt: 5_000, endedAt: 25_000 }),
      ]),
    ).toBe(24)
  })

  it('uses startedAt for a step that never settled', () => {
    expect(
      getWorkDurationSeconds([
        search('a', { startedAt: 0, endedAt: 3_000 }),
        search('b', { startedAt: 4_000 }),
      ]),
    ).toBe(4)
  })

  it('falls back to summed thinking durations for unstamped messages', () => {
    expect(
      getWorkDurationSeconds([
        thinking('t1', { duration: 4.7 }),
        search('a'),
        thinking('t2', { duration: 10.3 }),
      ]),
    ).toBe(15)
  })

  it('is undefined when nothing carries timing', () => {
    expect(
      getWorkDurationSeconds([
        thinking('t', { duration: undefined }),
        search('a'),
      ]),
    ).toBeUndefined()
  })
})

describe('WorkProcess once the run has finished', () => {
  it('collapses the steps behind a "Worked for" row and expands on click', () => {
    renderWork([
      thinking('t0', { startedAt: 0, endedAt: 4_700 }),
      search('s1', { startedAt: 4_700, endedAt: 30_000 }),
      search('s2', { startedAt: 30_000, endedAt: 90_000 }),
    ])

    const header = screen.getByRole('button', {
      name: 'Worked for 1.5 minutes',
    })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    const steps = header.nextElementSibling as HTMLElement
    expect(steps).toHaveAttribute('inert')
    expect(steps).toHaveStyle({ gridTemplateRows: '0fr' })
    expect(screen.getByText('Thought')).toBeInTheDocument()
    expect(screen.getAllByText('Searched the web')).toHaveLength(2)
    expect(screen.getByText('for "query s1"')).toBeInTheDocument()

    fireEvent.click(header)

    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(steps).not.toHaveAttribute('inert')
    expect(steps).toHaveStyle({ gridTemplateRows: '1fr' })
  })

  it('describes the step count when no timing is available', () => {
    renderWork([
      thinking('t0', { duration: undefined }),
      search('s1'),
      search('s2'),
    ])
    expect(getHeader()).toHaveTextContent('Worked through 3 steps')
  })

  it('does not call the summarizer for finished thinking', async () => {
    renderWork([thinking('t0'), search('s1')])
    await act(async () => {})
    expect(summarize).not.toHaveBeenCalled()
  })
})

describe('WorkProcess while the run is active', () => {
  it('shows the in-flight search with a spinner instead of a duration', () => {
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
    expect(header.querySelector('.animate-spin')).not.toBeNull()
    expect(container).not.toHaveTextContent(/Worked/)
  })

  it('shows the running URL fetch and code exec labels', () => {
    const { rerender } = renderWork(
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

    rerender(
      <WorkProcess
        blocks={[
          search('s0'),
          {
            type: 'code_exec',
            id: 'c1',
            calls: [
              {
                id: 'call-1',
                toolName: 'bash',
                arguments: { command: 'ls -la' },
                status: 'running',
              },
            ],
          },
        ]}
        isActive
        isDarkMode={false}
      />,
    )
    expect(getHeader()).toHaveTextContent('Running `ls -la`')
  })

  it('shows "Working" between steps when the last one has settled', () => {
    renderWork([thinking('t0'), search('s1')], true)
    expect(getHeader()).toHaveTextContent(/^Working$/)
  })

  it('surfaces the live thinking summary in the header and shares it with the step', async () => {
    const longThought = Array.from({ length: 30 }, (_, i) => `word${i}`).join(
      ' ',
    )
    summarize.mockResolvedValue('Weighing the tradeoffs')

    renderWork(
      [
        search('s0'),
        thinking('t1', { content: longThought, isThinking: true }),
      ],
      true,
    )
    const header = getHeader()
    expect(header).toHaveTextContent('Thinking')

    await act(async () => {
      await Promise.resolve()
    })

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize).toHaveBeenCalledWith({
      content: longThought,
      style: 'thoughts_summary',
    })
    expect(header).toHaveTextContent('Weighing the tradeoffs')
    // The nested ThoughtProcess shows the same summary without its own call.
    expect(screen.getAllByText('Weighing the tradeoffs')).toHaveLength(2)
    expect(summarize).toHaveBeenCalledTimes(1)
  })

  it('settles into "Worked for" once the run completes', () => {
    const { rerender } = renderWork(
      [
        thinking('t0', { startedAt: 0, endedAt: 2_000 }),
        search('s1', {
          startedAt: 2_000,
          state: { query: 'q', status: 'searching' },
        }),
      ],
      true,
    )
    expect(getHeader()).toHaveTextContent('Searching the web for "q"')

    rerender(
      <WorkProcess
        blocks={[
          thinking('t0', { startedAt: 0, endedAt: 2_000 }),
          search('s1', { startedAt: 2_000, endedAt: 12_500 }),
        ]}
        isActive={false}
        isDarkMode={false}
      />,
    )
    expect(getHeader()).toHaveTextContent('Worked for 12.5 seconds')
  })
})
