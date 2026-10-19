import { ImageLightbox } from '@/components/chat/image-gallery-context'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TfBoxX, TfImageSlash } from '@tinfoilsh/tinfoil-icons'
import { PiSpinner } from 'react-icons/pi'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ImageLightbox', () => {
  afterEach(() => vi.restoreAllMocks())

  it('replaces the loading spinner with the shared image-error icon on failure', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(
      false,
    )
    const { container: referenceIcon } = render(<TfImageSlash />)
    render(
      <ImageLightbox
        images={[{ key: 'failed', src: '/failed.png', alt: 'Failed image' }]}
        index={0}
        open
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
      />,
    )

    const image = (await screen.findAllByAltText('Failed image')).find(
      (element) => element.closest('.yarl__slide_current'),
    )!
    expect(image).toBeInTheDocument()
    const slide = image.closest('.yarl__slide')
    expect(slide?.querySelector('.yarl__slide_loading')).toBeInTheDocument()
    fireEvent.error(image)

    await waitFor(() => {
      const errorIcon = slide?.querySelector('svg.yarl__slide_error')
      expect(errorIcon?.innerHTML).toBe(
        referenceIcon.firstElementChild?.innerHTML,
      )
      expect(errorIcon).toHaveAttribute('aria-hidden', 'true')
      expect(slide?.querySelector('.yarl__slide_loading')).toBeNull()
    })
  })

  it('uses the shared close and loading icons without replacing the lightbox controls', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(
      false,
    )
    const onClose = vi.fn()
    const { container: referenceIcons } = render(
      <>
        <TfBoxX />
        <PiSpinner />
      </>,
    )
    render(
      <ImageLightbox
        images={[
          { key: 'first', src: '/first.png', alt: 'First image' },
          { key: 'second', src: '/second.png', alt: 'Second image' },
        ]}
        index={0}
        open
        onClose={onClose}
        onIndexChange={vi.fn()}
      />,
    )

    const closeButton = await screen.findByRole('button', { name: 'Close' })
    const closeIcon = closeButton.querySelector('svg')
    expect(closeIcon?.innerHTML).toBe(referenceIcons.children[0].innerHTML)
    expect(closeIcon).toHaveClass('yarl__icon')
    expect(closeIcon).toHaveAttribute('aria-hidden', 'true')

    await waitFor(() => {
      const spinner = document.querySelector('.yarl__slide_loading svg')
      expect(spinner?.innerHTML).toBe(referenceIcons.children[1].innerHTML)
      expect(spinner).toHaveClass(
        'yarl__icon',
        'animate-spin',
        'motion-reduce:animate-none',
      )
      expect(spinner).toHaveAttribute('aria-hidden', 'true')
    })
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeInTheDocument()

    const currentImage = screen.getByAltText('First image')
    fireEvent.load(currentImage)
    await waitFor(() =>
      expect(
        currentImage
          .closest('.yarl__slide')
          ?.querySelector('.yarl__slide_loading'),
      ).toBeNull(),
    )

    fireEvent.click(closeButton)
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
