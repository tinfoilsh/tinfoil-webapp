// @vitest-environment jsdom
import MapWidget from '@/components/chat/genui/widgets/MapView'
import { SANDBOX_ORIGIN } from '@/config'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const locations = [
  { name: 'Apple Park', latitude: 37.33, longitude: -122.01 },
  { name: 'Eiffel Tower', address: 'Paris' },
]

function ready(frame: HTMLIFrameElement) {
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'tinfoil-sandbox-ready',
          nonce: new URL(frame.src).hash.slice(1),
        },
      }),
    )
  })
  const run = post.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
  post.mockRestore()
  return run
}

describe('MapWidget', () => {
  it('asks for consent before contacting Apple', () => {
    const { getByText, queryByTitle } = render(
      <MapWidget locations={locations} />,
    )
    expect(getByText('Display on Apple Maps?')).toBeInTheDocument()
    expect(queryByTitle('Apple Maps')).toBeNull()
  })

  it('renders the map on the sandbox /map page with a real origin and sends only locations', () => {
    localStorage.setItem('tinfoil:apple-maps-consent', 'granted')
    const { getByTitle, getByText, queryByText } = render(
      <MapWidget locations={locations} mapType="hybrid" isDarkMode={true} />,
    )
    const frame = getByTitle('Apple Maps') as HTMLIFrameElement
    expect(frame.src.startsWith(`${SANDBOX_ORIGIN}/map#`)).toBe(true)
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(getByText('Loading map…')).toBeInTheDocument()

    const run = ready(frame)!
    expect(run).toMatchObject({
      kind: 'map',
      mapType: 'hybrid',
      isDarkMode: true,
      locations,
    })
    expect(Object.keys(run)).not.toContain('token')

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: {
            type: 'map-preview-status',
            instanceId: run.instanceId,
            status: 'ready',
          },
        }),
      )
    })
    expect(queryByText('Loading map…')).toBeNull()

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: {
            type: 'map-preview-status',
            instanceId: run.instanceId,
            status: 'error',
            message: 'token',
          },
        }),
      )
    })
    expect(getByText('Map unavailable')).toBeInTheDocument()
  })

  it.each([
    {
      route: locations,
      expected: {
        source: '37.33,-122.01',
        destination: 'Paris',
        mode: 'walking',
      },
    },
    {
      route: [locations[1]],
      expected: { destination: 'Paris', mode: 'walking' },
    },
    {
      route: [
        locations[0],
        { name: 'Stop', address: 'One & Two' },
        locations[1],
      ],
      expected: {
        source: '37.33,-122.01',
        destination: 'Paris',
        waypoint: 'One & Two',
        mode: 'walking',
      },
    },
  ])(
    'keeps the Apple Maps route $expected without loading any map code',
    ({ route, expected }) => {
      const { getByRole, queryByTitle } = render(
        <MapWidget locations={route} mode="directions" travelMode="walking" />,
      )
      expect(queryByTitle('Apple Maps')).toBeNull()
      const link = getByRole('link', { name: /open directions in apple maps/i })
      const url = new URL(link.getAttribute('href')!)
      expect(url.origin).toBe('https://maps.apple.com')
      expect(url.pathname).toBe('/directions')
      expect(Object.fromEntries(url.searchParams)).toEqual(expected)
    },
  )
})
