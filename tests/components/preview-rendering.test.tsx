// @vitest-environment jsdom
import { ArtifactPreviewPanel } from '@/components/chat/genui/widgets/ArtifactPreview'
import { MessageContent } from '@/components/chat/renderers/components/MessageContent'
import { CodeBlock } from '@/components/code-block'
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

beforeAll(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  ),
)
afterAll(() => vi.unstubAllGlobals())
afterEach(cleanup)

function previewDocument(frame: HTMLIFrameElement) {
  return new DOMParser().parseFromString(
    decodeURIComponent(frame.src.slice(frame.src.indexOf(',') + 1)),
    'text/html',
  )
}

function previewMessage(
  frame: HTMLIFrameElement,
  type: string,
  value: Record<string, unknown>,
) {
  const instanceId = previewDocument(frame).documentElement.textContent!.match(
    /instanceId: '([^']+)'/,
  )![1]
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type, instanceId, ...value },
      }),
    )
  })
}

describe('message formatting', () => {
  it('keeps document markup out while preserving formatting, math and code', async () => {
    const content = [
      '<p>Text<sup>2</sup><br>Next line</p>',
      '<iframe srcdoc="&lt;p>Nested document&lt;/p>"></iframe>',
      '<object data="https://example.com"></object><embed src="https://example.com">',
      '<style>body { color: red }</style><script type="application/json">{}</script>',
      '<div style="position: fixed" onmouseover="return false">Content</div>',
      '$$x^2$$',
      '```math\nx+1\n```',
      '```javascript\nconst value = 1;\n```',
      '| A | B |\n| - | - |\n| 1 | 2 |',
      '[Example](https://example.com)',
    ].join('\n\n')
    const { container, getByRole, getByText, getByLabelText } = render(
      <MessageContent content={content} isDarkMode={false} />,
    )
    await waitFor(() =>
      expect(container.querySelectorAll('.katex')).toHaveLength(2),
    )
    expect(
      container.querySelector('iframe, object, embed, style, script'),
    ).toBeNull()
    expect(getByText('Content')).not.toHaveAttribute('style')
    expect(getByText('Content')).not.toHaveAttribute('onmouseover')
    expect(container.querySelector('sup')).toHaveTextContent('2')
    expect(container.querySelector('br')).not.toBeNull()
    expect(getByRole('table')).toHaveTextContent('A')
    expect(getByRole('link', { name: 'Example' })).toHaveAttribute(
      'href',
      'https://example.com/',
    )
    expect(getByLabelText('Code block, javascript')).toHaveTextContent(
      'const value = 1;',
    )
  })
})

describe('code previews', () => {
  it('renders styled SVG as a standalone image', () => {
    const code =
      '<svg viewBox="0 0 120 40">\n<style>text { fill: blue }</style>\n<defs><linearGradient id="base"/><linearGradient xlink:href="#base"/></defs><text y="20">Preview&nbsp;image</text>\n</svg>'
    const { container, getByRole } = render(
      <CodeBlock code={code} language="svg" />,
    )
    const image = getByRole('img', { name: 'SVG preview' }) as HTMLImageElement
    expect(container.querySelector('svg style')).toBeNull()
    const document = new DOMParser().parseFromString(
      decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1)),
      'image/svg+xml',
    )
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.documentElement.namespaceURI).toBe(
      'http://www.w3.org/2000/svg',
    )
    expect(document.querySelector('style')?.textContent).toBe(
      'text { fill: blue }',
    )
    expect(document.querySelector('text')?.textContent).toBe(
      'Preview\u00a0image',
    )
    expect(
      document
        .querySelectorAll('linearGradient')[1]
        .getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
    ).toBe('#base')
  })

  it.each([
    '<!doctype html><html><head lang="en"><script>void 0</script></head><body><p>Preview</p></body></html>',
    '<!-- <head> -->\n<h1>Preview</h1>\n<script>void 0</script>',
  ])('places the HTML policy before document content', (code) => {
    const { getByRole, getByTitle } = render(
      <CodeBlock code={code} language="html" />,
    )
    fireEvent.click(getByRole('button', { name: 'Run' }))
    const frame = getByTitle('HTML preview') as HTMLIFrameElement
    const document = previewDocument(frame)
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(document.head.firstElementChild?.getAttribute('http-equiv')).toBe(
      'Content-Security-Policy',
    )
    expect(document.head.firstElementChild?.getAttribute('content')).toContain(
      "default-src 'none'",
    )
    expect(document.head.querySelector('script')).toBeNull()
    expect(document.body.querySelector('script')?.textContent).toBe('void 0')
  })

  it.each(['javascript', 'python'])(
    'accepts only bounded text output from the %s frame',
    (language) => {
      const code =
        language === 'python'
          ? 'print("</script >")\nprint("ready")'
          : 'const value = "</script >";\nconsole.log(value);'
      const { getByRole, getByTitle, queryByText } = render(
        <CodeBlock code={code} language={language} />,
      )
      fireEvent.click(getByRole('button', { name: 'Run' }))
      const frame = getByTitle(
        language === 'python' ? 'Python preview' : 'JavaScript preview',
      ) as HTMLIFrameElement
      const type =
        language === 'python' ? 'python-preview-output' : 'js-preview-output'
      const document = previewDocument(frame)
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
      expect(document.scripts).toHaveLength(1)
      expect(document.scripts[0].textContent).toContain('\\u003c/script >')
      previewMessage(frame, type, { output: ['Ready'] })
      expect(queryByText('Ready')).not.toBeNull()
      for (const output of [
        null,
        {},
        ['a', 1],
        Array(1001).fill('a'),
        ['a'.repeat(100_001)],
      ]) {
        previewMessage(frame, type, { output: ['Ready'] })
        previewMessage(frame, type, { output })
        if (language === 'python') {
          expect(queryByText('Ready')).toBeNull()
          expect(queryByText('No output')).not.toBeNull()
        } else {
          expect(queryByText('Ready')).not.toBeNull()
        }
      }
      previewMessage(frame, type, {
        instanceId: 'another-preview',
        output: ['Unrelated'],
      })
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: { type, output: ['Unrelated'] },
          }),
        )
      })
      expect(queryByText('Unrelated')).toBeNull()
    },
  )

  it.each([
    { reason: 'too many lines', output: Array(1001).fill('a') },
    { reason: 'too many characters', output: ['a'.repeat(100_001)] },
    { reason: 'invalid output', output: { text: 'Unexpected' } },
  ])('finishes loading Python after $reason', ({ output }) => {
    const { getByRole, getByTitle, queryByText, rerender } = render(
      <CodeBlock code={'print("ready")\nprint("done")'} language="python" />,
    )
    fireEvent.click(getByRole('button', { name: 'Run' }))
    const frame = getByTitle('Python preview') as HTMLIFrameElement
    expect(queryByText('Loading Python...')).not.toBeNull()

    previewMessage(frame, 'python-preview-output', {
      instanceId: 'another-preview',
      output,
    })
    expect(queryByText('Loading Python...')).not.toBeNull()

    previewMessage(frame, 'python-preview-output', { output })
    expect(queryByText('Loading Python...')).toBeNull()
    expect(queryByText('No output')).not.toBeNull()

    previewMessage(frame, 'python-preview-output', { output: ['Ready'] })
    expect(queryByText('Ready')).not.toBeNull()
    const previousSrc = frame.src
    rerender(
      <CodeBlock code={'print("next run")\nprint("done")'} language="python" />,
    )
    expect(getByTitle('Python preview')).toBe(frame)
    expect(frame.src).not.toBe(previousSrc)
    previewMessage(frame, 'python-preview-loading', {})
    expect(queryByText('Loading Python...')).not.toBeNull()
    previewMessage(frame, 'python-preview-output', { output })
    expect(queryByText('Loading Python...')).toBeNull()
    expect(queryByText('Ready')).toBeNull()
    expect(queryByText('No output')).not.toBeNull()

    previewMessage(frame, 'python-preview-output', {
      output: ['Latest result'],
    })
    expect(queryByText('Latest result')).not.toBeNull()
    expect(queryByText('No output')).toBeNull()
  })

  it.each(['html', 'css'])('bounds %s preview heights', (language) => {
    const code =
      language === 'html'
        ? '<h1>Preview</h1>\n<p>Content</p>'
        : 'body { color: blue; margin: 0; }\np { padding: 1px; }'
    const { getByRole, getByTitle } = render(
      <CodeBlock code={code} language={language} />,
    )
    if (language === 'html')
      fireEvent.click(getByRole('button', { name: 'Run' }))
    const frame = getByTitle(
      language === 'html' ? 'HTML preview' : 'CSS preview',
    ) as HTMLIFrameElement
    const type = `${language}-preview-height`
    previewMessage(frame, type, { height: 500 })
    expect(frame.style.height).toBe('500px')
    for (const height of [null, '500', Infinity, NaN]) {
      previewMessage(frame, type, { height })
      expect(frame.style.height).toBe('500px')
    }
    previewMessage(frame, type, { height: 1_000_000 })
    expect(frame.style.height).toBe('2000px')
    previewMessage(frame, type, { height: -1 })
    expect(frame.style.height).toBe(language === 'html' ? '100px' : '150px')
  })
})

it.each([
  { type: 'html' as const, html: '<h1>Artifact</h1>' },
  { type: 'url' as const, url: 'https://example.com/preview' },
])('keeps artifact frames on the same sandbox permissions', (source) => {
  const { getByTitle } = render(
    <ArtifactPreviewPanel source={source} title="Artifact" />,
  )
  expect(getByTitle('Artifact')).toHaveAttribute('sandbox', 'allow-scripts')
  expect(getByTitle('Artifact')).toHaveAttribute(
    'referrerpolicy',
    'no-referrer',
  )
})
