import { MessageContent } from '@/components/chat/renderers/components/MessageContent'
import { cleanup, render, waitFor } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Each render of a markdown block parses its text, and the blocks are found
// with the same parser, so these record every text the message parses.
const parsed = vi.hoisted(() => [] as string[])
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  return { ...actual, default: vi.fn(actual.default) }
})
vi.mock('remark-parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remark-parse')>()
  return {
    default: function recordedParse(
      this: { parser: (document: unknown) => unknown },
      options: unknown,
    ) {
      actual.default.call(this as never, options as never)
      const parser = this.parser
      this.parser = (document) => {
        parsed.push(String(document))
        return parser(document)
      }
    },
  }
})

const rendered = () =>
  vi.mocked(ReactMarkdown).mock.calls.map(([props]) => props.children)

const messageContent = (content: string, isStreaming: boolean) => (
  <MessageContent
    content={content}
    isDarkMode={false}
    isStreaming={isStreaming}
  />
)

// The markup of what a container shows. An element React updated in place
// lists the attributes it added after the others, so they are sorted.
function markup(node: Node): string {
  if (!(node instanceof Element)) return node.textContent ?? ''
  const attributes = [...node.attributes]
    .map(({ name, value }) => `${name}=${JSON.stringify(value)}`)
    .sort()
  const children = [...node.childNodes].map(markup).join('')
  return `<${node.localName} ${attributes.join(' ')}>${children}</${node.localName}>`
}

// The message as it shows when rendered whole, as a stored reply is.
function wholeRender(content: string) {
  const { container, unmount } = render(messageContent(content, false))
  const shown = markup(container)
  unmount()
  return shown
}

// The lengths a reply grows by between updates, so its updates end at
// every kind of place: within a line, at a line's end, between blocks.
const STEPS = [1, 2, 3, 5, 8, 13]

function prefixes(text: string) {
  const ends: number[] = []
  for (let end = 0, step = 0; end < text.length; step++) {
    end = Math.min(text.length, end + STEPS[step % STEPS.length])
    ends.push(end)
  }
  return ends.map((end) => text.slice(0, end))
}

const REPLIES = {
  'code with blank lines': [
    'Some code:',
    '',
    '```js',
    'const a = 1',
    '',
    '',
    'const b = 2',
    '```',
    '',
    'After the code.',
  ].join('\n'),
  'display math': [
    'The formula:',
    '',
    '$$',
    'x^2 + y^2',
    '',
    '= z^2',
    '$$',
    '',
    'And inline \\(a+b\\) or $c$.',
    '',
    '\\[',
    'e = mc^2',
    '\\]',
  ].join('\n'),
  'lists, loose and tight': [
    '1. First',
    '',
    '2. Second',
    '   continued',
    '',
    '   - nested',
    '   - items',
    '',
    'Between.',
    '',
    '- a',
    '- b',
    '* c',
    '',
    '3. Restarted',
  ].join('\n'),
  'a list whose next item follows a paragraph-like line': [
    '1. a',
    '',
    '2',
    '',
    '2. b',
  ].join('\n'),
  table: [
    'Intro',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    'Outro with | a pipe.',
  ].join('\n'),
  'headings and quotes': [
    '# Title',
    'Paragraph right after.',
    '',
    'Setext',
    '---',
    '',
    '> quoted',
    'lazy line',
    '',
    '    indented code',
    '',
    '    more code',
    '',
    '***',
    '',
    'End.',
  ].join('\n'),
  'raw HTML across blocks': [
    '<details>',
    '<summary>More</summary>',
    '',
    'Hidden **text**.',
    '',
    '</details>',
    '',
    'Para with <sup>1</sup> and a<br>break.',
    '',
    'Opened <span>here',
    '',
    'closed</span> there.',
  ].join('\n'),
}
// Definitions apply across blocks, so a reply with them renders whole.
const WITH_DEFINITIONS = [
  'See [the site][site] and a note[^1].',
  '',
  'More text.',
  '',
  '[site]: https://example.com',
  '[^1]: The note.',
].join('\n')

beforeAll(async () => {
  // The math plugins load once; replies render with them from then on.
  const { container, unmount } = render(messageContent('$$x$$', false))
  await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull())
  unmount()
})

beforeEach(() => {
  cleanup()
  parsed.length = 0
  vi.mocked(ReactMarkdown).mockClear()
})

describe('a streaming reply rendered in blocks', () => {
  it.each([
    ...Object.entries(REPLIES),
    ['link and footnote definitions', WITH_DEFINITIONS],
  ])('renders %s as the whole text does at every update', (_name, reply) => {
    const [first, ...rest] = prefixes(reply)
    const { container, rerender } = render(messageContent(first, true))
    // The reply goes on in blocks once it no longer streams, so each update
    // compares with the same text rendered whole as a finished reply.
    for (const prefix of rest.slice(0, -1)) {
      rerender(messageContent(prefix, false))
      expect(markup(container)).toBe(wholeRender(prefix))
    }
    vi.mocked(ReactMarkdown).mockClear()
    rerender(messageContent(reply, false))
    const parsedLast = rendered().join('')
    expect(markup(container)).toBe(wholeRender(reply))
    // The last update parsed the reply's first block only if it is whole.
    expect(parsedLast.includes(reply.split('\n')[0])).toBe(
      reply === WITH_DEFINITIONS,
    )
  })

  it('renders a reply streamed to its end as the whole text does', () => {
    const reply = Object.values(REPLIES).join('\n\n')
    const [first, ...rest] = prefixes(reply)
    const { container, rerender } = render(messageContent(first, true))
    for (const prefix of rest) rerender(messageContent(prefix, true))
    rerender(messageContent(reply, false))
    expect(markup(container)).toBe(wholeRender(reply))
  })

  it('parses only the block the reply goes on in', () => {
    const finished = [
      '# Title',
      '',
      'First paragraph.',
      '',
      '```js',
      'const a = 1',
      '',
      'const b = 2',
      '```',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '- one',
      '- two',
      '',
      '',
    ].join('\n')
    const { container, rerender } = render(
      messageContent(`${finished}Last para`, true),
    )
    parsed.length = 0
    vi.mocked(ReactMarkdown).mockClear()

    rerender(messageContent(`${finished}Last para grows`, true))

    expect(container).toHaveTextContent('Last para grows')
    expect(rendered()).toEqual(['Last para grows'])
    expect(parsed.every((text) => text === 'Last para grows')).toBe(true)

    parsed.length = 0
    vi.mocked(ReactMarkdown).mockClear()
    rerender(messageContent(`${finished}Last para grows\n\nNext one\n`, true))

    expect(container).toHaveTextContent('Next one')
    expect(rendered()).toEqual(['Last para grows\n\n', 'Next one\n'])
    expect(
      parsed.every((text) => text === 'Last para grows\n\nNext one\n'),
    ).toBe(true)
  })
})
