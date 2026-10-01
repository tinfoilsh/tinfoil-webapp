// @vitest-environment jsdom
import { ArtifactPreviewPanel } from '@/components/chat/genui/widgets/ArtifactPreview'
import { MessageContent } from '@/components/chat/renderers/components/MessageContent'
import { CodeBlock } from '@/components/code-block'
import { MermaidPreview } from '@/components/preview/mermaid-preview'
import {
  MERMAID_PREVIEW_URL,
  SANDBOX_PREVIEW_URL,
} from '@/components/preview/sandbox-frame'
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

/** In-origin runner frames embed their payload as a JSON data block in srcdoc. */
function runnerData(frame: HTMLIFrameElement): Record<string, unknown> {
  const document = new DOMParser().parseFromString(frame.srcdoc, 'text/html')
  return JSON.parse(document.getElementById('data')!.textContent!)
}

/** Sandbox frames receive one run message after announcing themselves ready. */
// Later ready messages are ignored by the hook, so remember the run per frame.
const sandboxRuns = new WeakMap<HTMLIFrameElement, Record<string, unknown>>()
function sandboxRun(frame: HTMLIFrameElement): Record<string, unknown> {
  const remembered = sandboxRuns.get(frame)
  if (remembered) return remembered
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'tinfoil-sandbox-ready',
          nonce: new URL(frame.src).hash.slice(1),
        },
      }),
    )
  })
  const [message, targetOrigin] = post.mock.calls.at(-1)!
  expect(targetOrigin).toBe('*')
  post.mockRestore()
  sandboxRuns.set(frame, message as Record<string, unknown>)
  return message as Record<string, unknown>
}

function instanceIdOf(frame: HTMLIFrameElement): string {
  return (frame.srcdoc ? runnerData(frame) : sandboxRun(frame))
    .instanceId as string
}

function previewMessage(
  frame: HTMLIFrameElement,
  type: string,
  value: Record<string, unknown>,
) {
  const instanceId = instanceIdOf(frame)
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

  it('runs HTML previews on the sandbox origin, only after it is ready', () => {
    const code = '<h1>Preview</h1>\n<script>void 0</script>'
    const { getByRole, getByTitle } = render(
      <CodeBlock code={code} language="html" />,
    )
    fireEvent.click(getByRole('button', { name: 'Run' }))
    const frame = getByTitle('HTML preview') as HTMLIFrameElement
    expect(frame.src.startsWith(`${SANDBOX_PREVIEW_URL}#`)).toBe(true)
    expect(new URL(frame.src).hash.length).toBeGreaterThan(20)
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    expect(post).not.toHaveBeenCalled()
    // A ready message without our nonce is ignored.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: { type: 'tinfoil-sandbox-ready', nonce: 'someone-else' },
        }),
      )
    })
    expect(post).not.toHaveBeenCalled()
    post.mockRestore()
    expect(sandboxRun(frame)).toMatchObject({
      type: 'tinfoil-sandbox-run',
      kind: 'html',
      code,
    })
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
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
      if (language === 'python') {
        // In-origin runner: code is JSON data, with `<` escaped so it can
        // never close the data block; the policy names this origin only.
        expect(frame.srcdoc).toContain('\\u003c/script >')
        expect(frame.srcdoc).not.toContain("'unsafe-inline'")
        expect(runnerData(frame)).toMatchObject({ code })
      } else {
        expect(frame.src.startsWith(`${SANDBOX_PREVIEW_URL}#`)).toBe(true)
        expect(sandboxRun(frame)).toMatchObject({ kind: 'js', code })
      }
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
    const previousDoc = frame.srcdoc
    const previousId = instanceIdOf(frame)
    rerender(
      <CodeBlock code={'print("next run")\nprint("done")'} language="python" />,
    )
    expect(getByTitle('Python preview')).toBe(frame)
    expect(frame.srcdoc).not.toBe(previousDoc)
    // A late result from the replaced document must not reach the new one.
    previewMessage(frame, 'python-preview-output', {
      instanceId: previousId,
      output: ['Stale result'],
    })
    expect(queryByText('Stale result')).toBeNull()
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

it('shows HTML artifacts only on request and runs them on the sandbox', () => {
  const html = '<h1>Artifact</h1>'
  const { getByRole, getByTitle, queryByTitle } = render(
    <ArtifactPreviewPanel source={{ type: 'html', html }} title="Artifact" />,
  )
  expect(queryByTitle('Artifact')).toBeNull()
  fireEvent.click(getByRole('button', { name: 'Preview' }))
  const frame = getByTitle('Artifact') as HTMLIFrameElement
  expect(frame.src.startsWith(`${SANDBOX_PREVIEW_URL}#`)).toBe(true)
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect(sandboxRun(frame)).toMatchObject({ kind: 'artifact', html })
})

it('returns HTML artifacts to source view when the panel shows a new one', () => {
  const { getByRole, getByTitle, queryByTitle, rerender } = render(
    <ArtifactPreviewPanel
      source={{ type: 'html', html: '<p>a</p>' }}
      title="Artifact"
    />,
  )
  fireEvent.click(getByRole('button', { name: 'Preview' }))
  expect(getByTitle('Artifact')).not.toBeNull()
  rerender(
    <ArtifactPreviewPanel
      source={{ type: 'html', html: '<p>b</p>' }}
      title="Artifact"
    />,
  )
  expect(queryByTitle('Artifact')).toBeNull()
})

it('frames URL artifacts directly with the same sandbox permissions', () => {
  const { getByTitle } = render(
    <ArtifactPreviewPanel
      source={{ type: 'url', url: 'https://example.com/preview' }}
      title="Artifact"
    />,
  )
  const frame = getByTitle('Artifact') as HTMLIFrameElement
  expect(frame.src).toBe('https://example.com/preview')
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
})

describe('mermaid preview', () => {
  it('renders in the in-origin Mermaid page and relays height and errors', () => {
    const { getByTitle, queryByText } = render(
      <MermaidPreview code="graph TD; A-->B" isDarkMode={true} />,
    )
    const frame = getByTitle('Mermaid preview') as HTMLIFrameElement
    expect(frame.src).toContain(`${MERMAID_PREVIEW_URL}#`)
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(sandboxRun(frame)).toMatchObject({
      kind: 'mermaid',
      code: 'graph TD; A-->B',
      isDarkMode: true,
    })
    previewMessage(frame, 'mermaid-preview-height', { height: 320 })
    expect(frame.style.height).toBe('320px')
    previewMessage(frame, 'mermaid-preview-error', { message: 'Parse error' })
    expect(queryByText('Mermaid error: Parse error')).not.toBeNull()
    expect(frame.className).toContain('hidden')
  })
})
