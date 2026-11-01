import { DocumentTextProvider } from '@/components/chat/document-text-context'
import { DocumentList } from '@/components/chat/renderers/components/DocumentList'
import type { Attachment } from '@/components/chat/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

function renderList(attachments: Attachment[], withLoader = true) {
  return render(
    <DocumentTextProvider load={withLoader ? load : undefined}>
      <DocumentList attachments={attachments} messageIndex={0} />
    </DocumentTextProvider>,
  )
}

beforeEach(() => {
  load.mockReset()
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
