import {
  computerUseAvailability,
  connectionIndicator,
  driverReadiness,
  readyImageNames,
  readyImages,
} from '@/services/computer-use/availability'
import type { DriverStatus } from '@/services/computer-use/types'
import { describe, expect, it } from 'vitest'

function status(images: DriverStatus['images'], running = true): DriverStatus {
  return { installed: true, running, version: '0.1', images }
}

const VISION = { modelName: 'kimi-k2-6', multimodal: true }
const TEXT = { modelName: 'gpt-oss-120b', multimodal: false }

describe('driverReadiness', () => {
  it('absent when null or not running', () => {
    expect(driverReadiness(null)).toBe('absent')
    expect(driverReadiness(status([], false))).toBe('absent')
  })
  it('no_images when running with no ready image', () => {
    expect(
      driverReadiness(status([{ name: 'a', os: 'mac', ready: false }])),
    ).toBe('no_images')
  })
  it('ready when at least one image is ready', () => {
    expect(
      driverReadiness(
        status([
          { name: 'a', os: 'mac', ready: false },
          { name: 'b', os: 'mac', ready: true },
        ]),
      ),
    ).toBe('ready')
  })
  it('no_images when running with images=null (Go nil-slice → JSON null)', () => {
    // Regression: the Go driver can serialise a nil slice as JSON `null`
    // rather than `[]`. Earlier this crashed `images.some()` and broke
    // every subsequent poll.
    expect(
      driverReadiness({
        installed: true,
        running: true,
        version: '0.1',
        images: null as unknown as DriverStatus['images'],
      }),
    ).toBe('no_images')
  })
})

describe('readyImageNames', () => {
  it('returns only ready image names', () => {
    expect(
      readyImageNames(
        status([
          { name: 'a', os: 'mac', ready: true },
          { name: 'b', os: 'linux', ready: false },
          { name: 'c', os: 'mac', ready: true },
        ]),
      ),
    ).toEqual(['a', 'c'])
  })
})

describe('readyImages', () => {
  it('returns ready images with their OS (so consent UI can derive session.os)', () => {
    expect(
      readyImages(
        status([
          { name: 'a', os: 'mac', ready: true },
          { name: 'b', os: 'linux', ready: false },
          { name: 'c', os: 'linux', ready: true },
        ]),
      ),
    ).toEqual([
      { name: 'a', os: 'mac', ready: true },
      { name: 'c', os: 'linux', ready: true },
    ])
  })

  it('returns [] when status is null (driver absent)', () => {
    expect(readyImages(null)).toEqual([])
  })
})

describe('computerUseAvailability', () => {
  it('non-vision model: expose nothing, no install CTA, explains why', () => {
    const a = computerUseAvailability({
      status: status([{ name: 'x', os: 'mac', ready: true }]),
      model: TEXT,
    })
    expect(a.exposeTools).toBe(false)
    expect(a.showInstallCTA).toBe(false)
    expect(a.reasons[0]).toMatch(/vision/i)
  })

  it('vision model + driver absent: install CTA only', () => {
    const a = computerUseAvailability({ status: null, model: VISION })
    expect(a).toMatchObject({
      driverState: 'absent',
      exposeTools: false,
      showInstallCTA: true,
    })
  })

  it('vision model + running, no images: expose tools with a setup hint, no CTA', () => {
    const a = computerUseAvailability({
      status: status([{ name: 'x', os: 'mac', ready: false }]),
      model: VISION,
    })
    expect(a.exposeTools).toBe(true)
    expect(a.showInstallCTA).toBe(false)
    expect(a.images).toEqual([])
    expect(a.reasons.join(' ')).toMatch(/image setup/i)
  })

  it('vision model + ready: expose tools, populate images, no CTA', () => {
    const a = computerUseAvailability({
      status: status([{ name: 'tahoe', os: 'mac', ready: true }]),
      model: VISION,
    })
    expect(a).toMatchObject({
      driverState: 'ready',
      exposeTools: true,
      showInstallCTA: false,
    })
    expect(a.images).toEqual(['tahoe'])
    expect(a.reasons).toEqual([])
  })

  it('unrecognized vision model + ready: expose but flag unreliability', () => {
    const a = computerUseAvailability({
      status: status([{ name: 'tahoe', os: 'mac', ready: true }]),
      model: { modelName: 'mystery-vlm', multimodal: true },
    })
    expect(a.exposeTools).toBe(true)
    expect(a.modelSupport.recognized).toBe(false)
    expect(a.reasons.join(' ')).toMatch(/unreliable|not specifically tuned/i)
  })
})

describe('connectionIndicator', () => {
  it('connected when status is running (even while re-probing)', () => {
    expect(connectionIndicator(status([]), true)).toBe('connected')
  })
  it('connecting when no status yet and a probe is in flight', () => {
    expect(connectionIndicator(null, true)).toBe('connecting')
  })
  it('disconnected when no status and not probing', () => {
    expect(connectionIndicator(null, false)).toBe('disconnected')
  })
})
