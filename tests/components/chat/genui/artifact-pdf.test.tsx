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
    renderChatCard('Run `npm test` 🎉')
    fireEvent.click(screen.getByRole('button', { name: 'Download as PDF' }))
    await waitFor(() => expect(saved).toHaveLength(1))

    const { text } = await extractText(
      new Uint8Array(await saved[0].blob.arrayBuffer()),
      { mergePages: true },
    )
    expect(normalized(text)).toContain('Run npm test 🎉')
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(
      ['DejaVuSans.ttf', 'DejaVuSansMono.ttf', 'NotoEmoji-Regular.ttf'].map(
        (name) => `${FONT_DIRECTORY}${name}`,
      ),
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
