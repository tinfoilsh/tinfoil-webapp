import { Favicon } from '@/components/ui/favicon'
import { harnessAPI } from '@/services/harness/runtime'
import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

it("looks up a site's favicon once for the citations shown together", async () => {
  let answer!: (value: unknown) => void
  vi.mocked(harnessAPI().client.post).mockImplementation(async (path) => {
    if (path !== '/v1/metadata/favicon')
      throw new Error(`Unexpected request: ${path}`)
    return new Promise((resolve) => {
      answer = resolve
    })
  })
  render(
    <>
      <Favicon url="https://shared.example/first-article" alt="first" />
      <Favicon url="https://shared.example/second-article" alt="second" />
    </>,
  )

  await act(async () =>
    answer({
      status: 'found',
      favicon_bytes: 'AQID',
      favicon_content_type: 'image/png',
    }),
  )

  for (const name of ['first', 'second'])
    expect(screen.getByRole('img', { name })).toHaveAttribute(
      'src',
      'data:image/png;base64,AQID',
    )
  expect(harnessAPI().client.post).toHaveBeenCalledExactlyOnceWith(
    '/v1/metadata/favicon',
    { url: 'https://shared.example/first-article' },
    expect.any(AbortSignal),
  )
})

it('shows a favicon in any image format, and nothing else', async () => {
  const answers: Record<string, unknown> = {
    'https://vector.example/': {
      status: 'found',
      favicon_bytes: 'PHN2Zy8+',
      favicon_content_type: 'image/svg+xml',
    },
    'https://page.example/': {
      status: 'found',
      favicon_bytes: 'PGh0bWw+',
      favicon_content_type: 'text/html',
    },
  }
  vi.mocked(harnessAPI().client.post).mockImplementation(async (path, body) => {
    if (path !== '/v1/metadata/favicon')
      throw new Error(`Unexpected request: ${path}`)
    return answers[(body as { url: string }).url]
  })
  render(
    <>
      <Favicon url="https://vector.example/" alt="vector" />
      <Favicon
        url="https://page.example/"
        alt="page"
        fallback={<span>no icon</span>}
      />
    </>,
  )

  expect(await screen.findByRole('img', { name: 'vector' })).toHaveAttribute(
    'src',
    'data:image/svg+xml;base64,PHN2Zy8+',
  )
  expect(await screen.findByText('no icon')).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'page' })).not.toBeInTheDocument()
})
