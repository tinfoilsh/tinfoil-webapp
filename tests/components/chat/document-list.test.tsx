import { DocumentTextProvider } from '@/components/chat/document-text-context'
import { DocumentList } from '@/components/chat/renderers/components/DocumentList'
import type { Attachment } from '@/components/chat/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const stored: Attachment = {
  id: 'att_report',
  type: 'document',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const load = vi.fn<(attachment: Attachment) => Promise<string>>()
const loadOriginal = vi.fn<(attachment: Attachment) => Promise<Blob>>()

function renderList(
  attachments: Attachment[],
  withLoader = true,
  withOriginals = false,
) {
  return render(
    <DocumentTextProvider
      load={withLoader ? load : undefined}
      loadOriginal={withOriginals ? loadOriginal : undefined}
    >
      <DocumentList attachments={attachments} messageIndex={0} />
    </DocumentTextProvider>,
  )
}

beforeEach(() => {
  load.mockReset()
  loadOriginal.mockReset()
})

describe('DocumentList document text', () => {
  it('reads a stored document as its chip shows, and previews its text', async () => {
    const reading = deferred<string>()
    load.mockReturnValueOnce(reading.promise)
    const { rerender } = renderList([stored])

    expect(load).toHaveBeenCalledExactlyOnceWith(stored)
    await act(async () =>
      reading.resolve('# Quarterly report\nRevenue grew.\nCosts fell.\n'),
    )
    expect(
      screen.getByRole('button', {
        name: /^report\.pdf Revenue grew\.\s+Costs fell\.$/,
      }),
    ).toBeInTheDocument()

    // Showing the chip again, or opening it, reads nothing again.
    rerender(
      <DocumentTextProvider load={(attachment) => load(attachment)}>
        <DocumentList attachments={[{ ...stored }]} messageIndex={0} />
      </DocumentTextProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '# Quarterly report Revenue grew. Costs fell.',
    )
    expect(load).toHaveBeenCalledOnce()
  })

  it('opens a document whose preview is still being read', async () => {
    const reading = deferred<string>()
    load.mockReturnValueOnce(reading.promise)
    renderList([stored])

    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    expect(screen.getByRole('dialog')).toHaveTextContent('Loading document…')
    await act(async () => reading.resolve('Revenue grew.'))
    expect(screen.getByRole('dialog')).toHaveTextContent('Revenue grew.')
    expect(load).toHaveBeenCalledOnce()
  })

  it('shows a failed read and reads the document again on request', async () => {
    load
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('Recovered text')
    renderList([stored])

    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This document could not be loaded.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByText('Recovered text', { selector: 'pre' }),
    ).toBeVisible()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shows text the message carries without reading it', () => {
    renderList([{ ...stored, textContent: 'Inline text' }])

    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    expect(screen.getByText('Inline text', { selector: 'pre' })).toBeVisible()
    expect(load).not.toHaveBeenCalled()
  })

  it('does not open a document whose text nothing can read', () => {
    renderList([stored], false)

    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('DocumentList uploaded files', () => {
  const kept: Attachment = {
    ...stored,
    textContent: 'Revenue grew.',
    hasOriginal: true,
  }

  // The files the page saves to the device, by the name and bytes of each.
  function captureSavedFiles() {
    const saved: { name: string; blob: Blob }[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      saved.push({ name: '', blob: blob as Blob })
      return `blob:saved-${saved.length}`
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved[saved.length - 1].name = this.download
    })
    return saved
  }

  it("saves the file a document was uploaded as under the document's name and type", async () => {
    const saved = captureSavedFiles()
    // The chat service sends the file's bytes without naming their type.
    loadOriginal.mockResolvedValue(
      new Blob(['%PDF-1.7'], { type: 'application/octet-stream' }),
    )
    renderList([kept], true, true)
    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Download original' }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(loadOriginal).toHaveBeenCalledExactlyOnceWith(kept)
    expect(saved[0].name).toBe('report.pdf')
    expect(saved[0].blob.type).toBe('application/pdf')
    expect(await saved[0].blob.text()).toBe('%PDF-1.7')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a download failed, and downloads the file again on request', async () => {
    const saved = captureSavedFiles()
    loadOriginal
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Blob(['%PDF-1.7']))
    renderList([kept], true, true)
    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Download original' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(saved).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Download original' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(loadOriginal).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      case: 'a document whose uploaded file is not kept',
      attachment: { ...kept, hasOriginal: undefined },
      withOriginals: true,
    },
    {
      case: 'a document where nothing reads uploaded files',
      attachment: kept,
      withOriginals: false,
    },
  ])('offers no download for $case', ({ attachment, withOriginals }) => {
    renderList([attachment], true, withOriginals)

    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }))

    expect(screen.getByRole('dialog')).toHaveTextContent('Revenue grew.')
    expect(
      screen.queryByRole('button', { name: 'Download original' }),
    ).not.toBeInTheDocument()
  })
})
