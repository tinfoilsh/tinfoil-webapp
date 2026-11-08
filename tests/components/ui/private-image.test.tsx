import { PrivateImage } from '@/components/ui/private-image'
import { loadRemoteImage } from '@/services/harness/remote-images'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { client, signIn } from '../../harness-fixture'

const IMAGE = { image_bytes: 'AQID', image_content_type: 'image/png' }
const DATA_URL = 'data:image/png;base64,AQID'
const SOURCE = 'https://images.example/private-token.png'

beforeEach(() => signIn())

it('keeps remote sources and srcset out of the DOM while fetching once through the harness', async () => {
  let answer!: (value: unknown) => void
  client.post.mockImplementation(async (path) => {
    if (path !== '/v1/metadata/image') throw new Error('Unexpected request')
    return new Promise((resolve) => {
      answer = resolve
    })
  })
  render(
    <>
      <PrivateImage
        src={SOURCE}
        srcSet="https://tracker.example/large.png 2x"
        alt="first"
      />
      <PrivateImage src={SOURCE} alt="second" />
    </>,
  )
  expect(document.querySelector('img[src], img[srcset]')).toBeNull()
  await waitFor(() => expect(client.post).toHaveBeenCalledTimes(1))
  await act(async () => answer(IMAGE))
  for (const name of ['first', 'second']) {
    expect(screen.getByRole('img', { name })).toHaveAttribute('src', DATA_URL)
    expect(screen.getByRole('img', { name })).not.toHaveAttribute('srcset')
  }
  expect(client.post).toHaveBeenCalledWith(
    '/v1/metadata/image',
    { url: SOURCE },
    expect.any(AbortSignal),
  )
})

it('never falls back to the remote URL after a request failure', async () => {
  client.post.mockRejectedValue(new Error('Unavailable'))
  render(<PrivateImage src={SOURCE} alt="unavailable" />)
  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'unavailable' })).toHaveAttribute(
      'aria-busy',
      'false',
    ),
  )
  expect(document.querySelector('img[src]')).toBeNull()
})

it('does not let an old URL overwrite the image selected later', async () => {
  const answers = new Map<string, (value: unknown) => void>()
  client.post.mockImplementation(async (path, input) => {
    if (path !== '/v1/metadata/image') throw new Error('Unexpected request')
    return new Promise((resolve) =>
      answers.set((input as { url: string }).url, resolve),
    )
  })
  const next = 'https://images.example/next.png'
  const view = render(<PrivateImage src={SOURCE} alt="current" />)
  await waitFor(() => expect(answers.has(SOURCE)).toBe(true))
  view.rerender(<PrivateImage src={next} alt="current" />)
  await waitFor(() => expect(answers.has(next)).toBe(true))
  await act(async () => answers.get(next)!({ ...IMAGE, image_bytes: 'BAUG' }))
  await act(async () => answers.get(SOURCE)!(IMAGE))
  expect(screen.getByRole('img', { name: 'current' })).toHaveAttribute(
    'src',
    'data:image/png;base64,BAUG',
  )
})

it('drops a pending image and its cache when the account changes', async () => {
  let answer!: (value: unknown) => void
  client.post.mockImplementation(
    async () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  const first = loadRemoteImage(SOURCE)
  const refused = expect(first).rejects.toThrow()
  await waitFor(() => expect(answer).toBeDefined())
  signIn({ userId: 'bob' })
  client.post.mockResolvedValue({ ...IMAGE, image_bytes: 'BAUG' })
  answer(IMAGE)
  await refused
  expect(await loadRemoteImage(SOURCE)).toBe('data:image/png;base64,BAUG')
  expect(client.post).toHaveBeenCalledTimes(1)
})

it('rejects active image types even when the transport returns them', async () => {
  client.post.mockResolvedValue({
    image_bytes: 'PHN2Zy8+',
    image_content_type: 'image/svg+xml',
  })
  await expect(loadRemoteImage(SOURCE)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  })
})
