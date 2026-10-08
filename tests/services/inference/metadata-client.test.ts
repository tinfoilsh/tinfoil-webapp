import {
  fetchFavicon,
  fetchLinkMetadata,
  MetadataClientError,
} from '@/services/inference/metadata-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
}))

vi.mock('tinfoil', () => ({
  SecureClient: class {
    fetch = mockFetch
  },
}))

const FAVICON_DATA_URL = 'data:image/x-icon;base64,aWNvbg=='
const FAVICON_BYTES = 'aWNvbg=='

function faviconResponse(): Response {
  return new Response(
    JSON.stringify({
      status: 'found',
      favicon_bytes: FAVICON_BYTES,
      favicon_content_type: 'image/x-icon',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('fetchFavicon', () => {
  beforeEach(() => {
    mockFetch.mockReset().mockImplementation(async () => faviconResponse())
  })

  it('uses the favicon-only enclave endpoint', async () => {
    await expect(fetchFavicon('https://example.com/page')).resolves.toBe(
      FAVICON_DATA_URL,
    )
    expect(mockFetch).toHaveBeenCalledWith(
      'https://opengraph-metadata.tinfoil.sh/favicon',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://example.com/page' }),
      }),
    )
  })

  it('deduplicates concurrent requests for the same hostname', async () => {
    let finish!: (response: Response) => void
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    mockFetch.mockResolvedValueOnce(
      Response.json({
        status: 'missing',
        favicon_bytes: '',
        favicon_content_type: '',
      }),
    )
    const first = fetchFavicon('https://example.org/one')
    const second = fetchFavicon('https://example.org/two')

    try {
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await expect(fetchFavicon('https://other.example/')).resolves.toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(2)
    } finally {
      finish(faviconResponse())
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      FAVICON_DATA_URL,
      FAVICON_DATA_URL,
    ])
    await expect(fetchFavicon('https://example.org/again')).resolves.toBe(
      FAVICON_DATA_URL,
    )
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('returns null when the enclave reports a missing favicon', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'missing',
          favicon_bytes: '',
          favicon_content_type: '',
        }),
        { status: 200 },
      ),
    )

    await expect(fetchFavicon('https://missing.example')).resolves.toBeNull()
  })

  it.each([
    { bytes: '', contentType: 'image/png' },
    { bytes: FAVICON_BYTES, contentType: 'text/plain' },
  ])(
    'rejects found responses without valid image data: $bytes / $contentType',
    async ({ bytes, contentType }) => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'found',
            favicon_bytes: bytes,
            favicon_content_type: contentType,
          }),
          { status: 200 },
        ),
      )

      await expect(fetchFavicon('https://invalid.example')).rejects.toThrow(
        'Invalid found favicon response',
      )
    },
  )

  it('does not cache transient failures', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(faviconResponse())

    await expect(fetchFavicon('https://transient.example')).rejects.toThrow(
      'Favicon fetch failed: 503',
    )
    await expect(fetchFavicon('https://transient.example')).resolves.toBe(
      FAVICON_DATA_URL,
    )
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('fetchLinkMetadata', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('maps metadata responses', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: 'https://example.com/',
          title: 'Example',
          description: null,
          site_name: 'Example Site',
          image: null,
          cached: false,
        }),
        { status: 200 },
      ),
    )

    await expect(fetchLinkMetadata('https://example.com/')).resolves.toEqual({
      url: 'https://example.com/',
      title: 'Example',
      description: null,
      siteName: 'Example Site',
      image: null,
      cached: false,
    })
  })

  it('rejects non-success responses', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('unavailable', { status: 502 }),
    )

    await expect(
      fetchLinkMetadata('https://failure.example/'),
    ).rejects.toMatchObject({
      name: 'MetadataClientError',
      code: 'HTTP_ERROR',
      status: 502,
    } satisfies Partial<MetadataClientError>)
  })

  it.each([
    { image: '   ', expected: null },
    { image: 'javascript:alert(1)', expected: null },
    {
      image: ' https://images.example/preview.png ',
      expected: 'https://images.example/preview.png',
    },
    {
      image: 'http://images.example/preview.png',
      expected: 'http://images.example/preview.png',
    },
  ])('normalizes preview image URLs: $image', async ({ image, expected }) => {
    mockFetch.mockResolvedValueOnce(
      Response.json({
        url: 'https://example.com/',
        title: ' Example ',
        description: null,
        site_name: null,
        image,
        cached: false,
      }),
    )
    await expect(
      fetchLinkMetadata('https://example.com/'),
    ).resolves.toMatchObject({
      title: 'Example',
      image: expected,
    })
  })

  it('classifies malformed metadata responses', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      fetchLinkMetadata('https://invalid-response.example/'),
    ).rejects.toMatchObject({
      name: 'MetadataClientError',
      code: 'INVALID_RESPONSE',
      status: 200,
    })
  })
})
