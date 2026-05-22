import {
  COMPUTER_BEGIN_TOOL_NAME,
  buildComputerBeginSchema,
} from '@/services/computer-use/manifest-schema'
import { describe, expect, it } from 'vitest'

function props(schema: ReturnType<typeof buildComputerBeginSchema>) {
  return (schema.function.parameters as any).properties
}

describe('buildComputerBeginSchema', () => {
  it('names the tool computer_begin and produces an object schema', () => {
    const s = buildComputerBeginSchema(['tahoe'])
    expect(s.function.name).toBe(COMPUTER_BEGIN_TOOL_NAME)
    expect(s.function.parameters).toMatchObject({ type: 'object' })
  })

  it('constrains session.image to the ready images as an enum', () => {
    const s = buildComputerBeginSchema(['tahoe', 'linux-box'])
    const image = props(s).session.properties.image
    expect(image.enum).toEqual(['tahoe', 'linux-box'])
  })

  it('falls back to a plain string when no images are ready', () => {
    const s = buildComputerBeginSchema([])
    const image = props(s).session.properties.image
    expect(image.enum).toBeUndefined()
    expect(image.type).toBe('string')
  })

  it('requires version and session, and exposes the manifest fields', () => {
    const params = buildComputerBeginSchema(['x']).function.parameters as any
    expect(params.required).toEqual(
      expect.arrayContaining(['version', 'session']),
    )
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining([
        'version',
        'session',
        'mounts',
        'network',
        'devices',
        'display',
      ]),
    )
  })

  it('models egress as a string array under network', () => {
    const network = props(buildComputerBeginSchema(['x'])).network
    expect(network.properties.egress.type).toBe('array')
    expect(network.properties.egress.items.type).toBe('string')
  })
})
