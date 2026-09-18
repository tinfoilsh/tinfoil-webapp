import {
  buildTextPreviewExcerpt,
  FilePreview,
  imageDataUrl,
} from '@/components/chat/components/file-preview'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('FilePreview', () => {
  it('renders an image thumbnail when a source is provided', () => {
    render(
      <FilePreview
        filename="photo.png"
        imageSrc="data:image/jpeg;base64,AAAA"
        textContent="ignored"
      />,
    )
    const tile = screen.getByTestId('file-preview')
    expect(tile).toHaveAttribute('data-preview-kind', 'image')
    expect(screen.getByAltText('photo.png')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,AAAA',
    )
  })

  it('renders the document text for plain-text files', () => {
    render(
      <FilePreview filename="notes.txt" textContent={'first line\nsecond'} />,
    )
    const tile = screen.getByTestId('file-preview')
    expect(tile).toHaveAttribute('data-preview-kind', 'text')
    expect(tile.querySelector('pre')).toHaveTextContent('first line second')
  })

  it('falls back to a file icon for text-less or binary documents', () => {
    const { rerender } = render(
      <FilePreview filename="report.pdf" textContent="Extracted text" />,
    )
    expect(screen.getByTestId('file-preview')).toHaveAttribute(
      'data-preview-kind',
      'icon',
    )

    rerender(<FilePreview filename="notes.txt" textContent="   " />)
    expect(screen.getByTestId('file-preview')).toHaveAttribute(
      'data-preview-kind',
      'icon',
    )
  })

  it('shows a bare spinner while a file is still processing', () => {
    render(<FilePreview filename="photo.avif" isBusy />)
    const tile = screen.getByTestId('file-preview')
    expect(tile).toHaveAttribute('data-preview-kind', 'pending')
    expect(tile.className).not.toContain('border')
  })

  it('keeps the thumbnail visible under the busy overlay', () => {
    render(
      <FilePreview
        filename="photo.png"
        imageSrc="data:image/jpeg;base64,AAAA"
        isBusy
      />,
    )
    expect(screen.getByTestId('file-preview')).toHaveAttribute(
      'data-preview-kind',
      'image',
    )
    expect(screen.getByAltText('photo.png')).toBeInTheDocument()
  })

  it('does not render a thumbnail for images without data', () => {
    render(<FilePreview filename="photo.png" textContent="A description" />)
    expect(screen.getByTestId('file-preview')).toHaveAttribute(
      'data-preview-kind',
      'icon',
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('buildTextPreviewExcerpt', () => {
  it('normalizes line endings and truncates long content', () => {
    const excerpt = buildTextPreviewExcerpt('a\r\nb\rc')
    expect(excerpt).toBe('a\nb\nc')

    const manyLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      '\n',
    )
    expect(buildTextPreviewExcerpt(manyLines).split('\n')).toHaveLength(24)

    const longLine = 'x'.repeat(5000)
    expect(buildTextPreviewExcerpt(longLine)).toHaveLength(600)
  })
})

describe('imageDataUrl', () => {
  it('builds a data URL and defaults the mime type', () => {
    expect(imageDataUrl('QUJD', 'image/png')).toBe('data:image/png;base64,QUJD')
    expect(imageDataUrl('QUJD', undefined)).toBe('data:image/jpeg;base64,QUJD')
    expect(imageDataUrl(undefined, 'image/png')).toBeNull()
  })
})
