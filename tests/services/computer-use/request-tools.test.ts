import {
  computerUseRequestTools,
  extractComputerBegin,
} from '@/services/computer-use/request-tools'
import { describe, expect, it, vi } from 'vitest'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const READY_STATUS = {
  installed: true,
  running: true,
  version: '0.1',
  images: [{ name: 'tahoe', os: 'mac', ready: true }],
}

describe('computerUseRequestTools', () => {
  it('returns the computer_begin tool for a vision model + ready driver + enabled toggle', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(READY_STATUS),
    ) as unknown as typeof fetch
    const tools = await computerUseRequestTools({
      model: { modelName: 'kimi-k2-6', multimodal: true },
      enabled: true,
      fetchImpl,
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].function.name).toBe('computer_begin')
    // image enum populated from /status
    const image = (tools[0].function.parameters as any).properties.session
      .properties.image
    expect(image.enum).toEqual(['tahoe'])
  })

  it('returns [] when the toggle is off and the driver is ready (computer_begin is gated)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(READY_STATUS),
    ) as unknown as typeof fetch
    const tools = await computerUseRequestTools({
      model: { modelName: 'kimi-k2-6', multimodal: true },
      enabled: false,
      fetchImpl,
    })
    expect(tools).toEqual([])
  })

  it('returns [] when driver is unreachable (install funnel is webapp-side now)', async () => {
    // The webapp commits a static install card from the toggle's "Ask Tin"
    // handler instead of going through a model tool — see
    // ComputerUseInstallCard + chat-interface.handleComputerUseAsk. So
    // an unreachable driver should yield no tool here.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const tools = await computerUseRequestTools({
      model: { modelName: 'kimi-k2-6', multimodal: true },
      enabled: true,
      fetchImpl,
    })
    expect(tools).toEqual([])
  })

  it('returns [] for a non-vision model regardless of driver/enabled state', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(READY_STATUS),
    ) as unknown as typeof fetch
    const tools = await computerUseRequestTools({
      model: { modelName: 'gpt-oss', multimodal: false },
      enabled: true,
      fetchImpl,
    })
    expect(tools).toEqual([])
  })
})

describe('extractComputerBegin', () => {
  const manifest = {
    version: 1,
    session: { os: 'mac', image: 'tahoe', clone: true },
  }

  it('parses the manifest from a computer_begin tool call', () => {
    const r = extractComputerBegin({
      toolCalls: [
        { name: 'computer_begin', arguments: JSON.stringify(manifest) },
      ],
    })
    expect(r?.manifest.session.image).toBe('tahoe')
  })

  it('returns null when there is no computer_begin call', () => {
    expect(
      extractComputerBegin({
        toolCalls: [{ name: 'render_chart', arguments: '{}' }],
      }),
    ).toBeNull()
    expect(extractComputerBegin({})).toBeNull()
  })

  it('returns null for an unparseable or sessionless manifest', () => {
    expect(
      extractComputerBegin({
        toolCalls: [{ name: 'computer_begin', arguments: '{bad' }],
      }),
    ).toBeNull()
    expect(
      extractComputerBegin({
        toolCalls: [{ name: 'computer_begin', arguments: '{"version":1}' }],
      }),
    ).toBeNull()
  })
})
