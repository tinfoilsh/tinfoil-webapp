import { GenUIToolCallRenderer } from '@/components/chat/genui/GenUIToolCallRenderer'
import { ArtifactPreviewPanel } from '@/components/chat/genui/widgets/ArtifactPreview'
import PDF_FONT_FILES from '@/utils/pdf-fonts.json'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { extractText, getMeta } from 'unpdf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAYBOOK_MARKDOWN, PLAYBOOK_TITLE } from './artifact-fixture'

const FONT_DIRECTORY = '/vendor/fonts/'

interface Request {
  url: string
  method: string
  body: unknown
}

let requests: Request[]
let missingFonts: Set<string>
let saved: { filename: string; blob: Blob }[]
let origins = 0

const { happyDOM } = window as unknown as {
  happyDOM: { setURL: (url: string) => void }
}

// Serves the font files `scripts/copy-vendor.mjs` copies, as this origin would.
async function fontServer(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input)
  requests.push({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ?? null,
  })
  const { origin, pathname } = new URL(url)
  const name = pathname.slice(FONT_DIRECTORY.length)
  const source = (PDF_FONT_FILES as Record<string, string>)[name]
  if (
    origin !== window.location.origin ||
    !pathname.startsWith(FONT_DIRECTORY) ||
    !source ||
    missingFonts.has(name)
  ) {
    return new Response(null, { status: 404 })
  }
  return new Response(readFileSync(`node_modules/${source}`))
}

beforeEach(() => {
  // The PDF library keeps the fonts it fetched by URL for the session, so
  // each test runs on an origin of its own to start without them.
  const page = window.location.href
  happyDOM.setURL(`http://pdf-${++origins}.localhost/chat`)
  requests = []
  missingFonts = new Set()
  saved = []
  vi.stubGlobal('fetch', vi.fn(fontServer))
  vi.stubGlobal('navigator', { ...navigator, sendBeacon: vi.fn() })
  vi.spyOn(XMLHttpRequest.prototype, 'open')
  const blobs = new Map<string, Blob>()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:${window.location.origin}/${blobs.size}`
    blobs.set(url, blob as Blob)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ filename: this.download, blob: blobs.get(this.href)! })
  })
  return () => happyDOM.setURL(page)
})

function renderChatCard(markdown = PLAYBOOK_MARKDOWN) {
  render(
    <GenUIToolCallRenderer
      isStreaming={false}
      toolCalls={[
        {
          id: 'artifact-1',
          name: 'render_artifact_preview',
          arguments: JSON.stringify({
            title: PLAYBOOK_TITLE,
            source: { type: 'markdown', markdown },
          }),
        },
      ]}
    />,
  )
}

function renderPanel() {
  render(
    <ArtifactPreviewPanel
      title={PLAYBOOK_TITLE}
      source={{ type: 'markdown', markdown: PLAYBOOK_MARKDOWN }}
      layout="sidebar"
    />,
  )
}

const normalized = (text: string) => text.replace(/\s+/g, ' ')

describe('Markdown artifact PDF', () => {
  it.each([
    { from: 'the chat card', show: renderChatCard },
    { from: 'the preview panel', show: renderPanel },
  ])(
    'saves a PDF of the artifact, made on this device, from $from',
    async ({ show }) => {
      show()
      fireEvent.click(screen.getByRole('button', { name: 'Download as PDF' }))
      await waitFor(() => expect(saved).toHaveLength(1))

      const [{ filename, blob }] = saved
      expect(filename).toBe('Apartment-Expense-Structure-Setup-Playbook.pdf')
      expect(blob.type).toBe('application/pdf')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const { info } = await getMeta(bytes.slice())
      expect(info.Title).toBe(PLAYBOOK_TITLE)
      const { totalPages, text } = await extractText(bytes.slice(), {
        mergePages: true,
      })
      expect(totalPages).toBeGreaterThan(1)
      const pdfText = normalized(text)
      for (const line of [
        'Apartment Expense Structure — Setup Playbook',
        'Lease facts: 135 Pierce St, San Francisco · $9,700/month · Term: Jul 1, 2026 – Aug 30, 2027',
        'Flow Amount Who',
        'Company reimbursement (documented business half) $4,850/mo Tinfoil → you (tax-free)',
        '☐ Adopt the expense policy (draft in §3) — board note or Notion page is fine',
        'Business expense reimbursement. The Company reimburses employees',
        'Jul 22 [Name], [Name] Employees No Team dinner (9 people)',
        'Charge Tinfoil rent or a "venue fee" for the space',
        "❌ Don't ✅ Instead",
        'notify landlord ≥15 days before',
      ]) {
        expect(pdfText).toContain(line)
      }
      for (const markup of ['|', '[ ]', '**', '---']) {
        expect(pdfText).not.toContain(markup)
      }

      // Only the fonts the document is set in, from this origin, and nothing
      // else.
      expect(
        requests.map(({ url, method, body }) => {
          const { origin, pathname } = new URL(url)
          return { origin, pathname, method, body }
        }),
      ).toEqual(
        [
          'DejaVuSans.ttf',
          'DejaVuSans-Bold.ttf',
          'DejaVuSans-Oblique.ttf',
          'NotoEmoji-Bold.ttf',
        ].map((name) => ({
          origin: window.location.origin,
          pathname: `${FONT_DIRECTORY}${name}`,
          method: 'GET',
          body: null,
        })),
      )
      expect(navigator.sendBeacon).not.toHaveBeenCalled()
      expect(XMLHttpRequest.prototype.open).not.toHaveBeenCalled()

      // Another copy reuses the fonts.
      fireEvent.click(screen.getByRole('button', { name: 'Download as PDF' }))
      await waitFor(() => expect(saved).toHaveLength(2))
      expect(saved[1].filename).toBe(filename)
      expect(requests).toHaveLength(4)
    },
  )

  it('fetches the monospace and regular emoji fonts only for code and emoji that use them', async () => {
    renderChatCard('Run `npm test` 🎉 to check $$E = mc^2$$')
    fireEvent.click(screen.getByRole('button', { name: 'Download as PDF' }))
    await waitFor(() => expect(saved).toHaveLength(1))

    const { text } = await extractText(
      new Uint8Array(await saved[0].blob.arrayBuffer()),
      { mergePages: true },
    )
    expect(normalized(text)).toContain('Run npm test 🎉 to check E = mc^2')
    expect(text).not.toContain('$$')
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(
      ['DejaVuSans.ttf', 'DejaVuSansMono.ttf', 'NotoEmoji-Regular.ttf'].map(
        (name) => `${FONT_DIRECTORY}${name}`,
      ),
    )
  })

  it('keeps a row taller than a page whole, and a closing heading with the text before it', async () => {
    const words = Array.from({ length: 1500 }, (_, index) => `w${index}`)
    renderChatCard(
      `| Item | Notes |\n|---|---|\n| long | ${words.join(' ')} |\n| next | row |\n\nAfter the table.\n\n## Closing heading\n`,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download as PDF' }))
    await waitFor(() => expect(saved).toHaveLength(1))

    const { totalPages, text } = await extractText(
      new Uint8Array(await saved[0].blob.arrayBuffer()),
      { mergePages: false },
    )
    expect(totalPages).toBeGreaterThan(1)
    const pages = text.map(normalized)
    const printed = new Set(pages.join(' ').split(' '))
    expect(words.filter((word) => !printed.has(word))).toEqual([])
    expect(pages.slice(1).every((page) => page.startsWith('Item Notes '))).toBe(
      true,
    )
    expect(pages.at(-1)).toContain('next row After the table. Closing heading')
  })

  it('moves a heading that would end a page to the next page', async () => {
    const { createMarkdownPdf } = await import('@/utils/markdown-pdf')
    const pageEnds: string[] = []
    // As the filler grows, the heading reaches the foot of the first page.
    for (let lines = 24; lines <= 44; lines++) {
      const filler = Array.from({ length: lines }, (_, line) => `Line ${line}.`)
      const pdf = await createMarkdownPdf(
        `${filler.join('\n\n')}\n\n## Section heading\n\nSection text.`,
      )
      const { text } = await extractText(
        new Uint8Array(await pdf.arrayBuffer()),
        { mergePages: false },
      )
      for (const page of text.slice(0, -1))
        pageEnds.push(normalized(page).replace(/\s*\d+ \/ \d+\s*$/, ''))
    }
    expect(pageEnds.length).toBeGreaterThan(0)
    expect(pageEnds.filter((end) => end.endsWith('Section heading'))).toEqual(
      [],
    )
  })

  it('saves nothing and can try again when a font cannot be loaded', async () => {
    missingFonts.add('NotoEmoji-Bold.ttf')
    renderChatCard()
    const button = screen.getByRole('button', { name: 'Download as PDF' })
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())
    await waitFor(() => expect(button).toBeEnabled())
    expect(saved).toEqual([])

    missingFonts.clear()
    fireEvent.click(button)
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].filename).toBe(
      'Apartment-Expense-Structure-Setup-Playbook.pdf',
    )
  })

  it('offers a PDF only for Markdown artifacts', () => {
    render(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          {
            id: 'artifact-1',
            name: 'render_artifact_preview',
            arguments: JSON.stringify({
              title: 'Page',
              source: { type: 'html', html: '<main>Page</main>' },
            }),
          },
        ]}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Download artifact' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Download as PDF' }),
    ).not.toBeInTheDocument()
  })
})
