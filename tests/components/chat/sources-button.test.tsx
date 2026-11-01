import { SourcesButton } from '@/components/chat/renderers/components/SourcesButton'
import { harnessAPI } from '@/services/harness/runtime'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

it('keeps a badge for each source while its icon loads and when it has none', async () => {
  const answers = new Map<string, (value: unknown) => void>()
  vi.mocked(harnessAPI().client.post).mockImplementation(async (path, body) => {
    if (path !== '/v1/metadata/favicon')
      throw new Error(`Unexpected request: ${path}`)
    return new Promise((resolve) => {
      answers.set((body as { url: string }).url, resolve)
    })
  })
  render(
    <SourcesButton
      sources={[
        { url: 'https://icon.example/a', title: 'With an icon' },
        { url: 'https://plain.example/b', title: 'Without an icon' },
      ]}
    />,
  )
  const pill = screen.getByRole('button', { name: 'Show 2 sources' })
  const badges = () => [...pill.lastElementChild!.children]
  expect(badges().map((badge) => badge.tagName)).toEqual(['SPAN', 'SPAN'])

  await act(async () => {
    answers.get('https://icon.example/a')!({
      status: 'found',
      favicon_bytes: 'AQID',
      favicon_content_type: 'image/png',
    })
    answers.get('https://plain.example/b')!({
      status: 'missing',
      favicon_bytes: '',
      favicon_content_type: '',
    })
  })

  const [icon, plain] = badges()
  expect(icon.tagName).toBe('IMG')
  expect(icon).toHaveAttribute('src', 'data:image/png;base64,AQID')
  expect(plain.tagName).toBe('SPAN')

  fireEvent.click(pill)
  const rows = within(screen.getByRole('dialog')).getAllByRole('link')
  expect(
    rows.map((row) => [row.textContent, row.firstElementChild!.tagName]),
  ).toEqual([
    ['With an iconicon.example', 'IMG'],
    ['Without an iconplain.example', 'SPAN'],
  ])
})
