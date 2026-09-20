import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createSpeech } = vi.hoisted(() => ({ createSpeech: vi.fn() }))
vi.mock('tinfoil', () => ({
  TinfoilAI: class {
    audio = { speech: { create: createSpeech } }
  },
}))

const originalExitCode = process.exitCode
let stderr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  createSpeech.mockReset()
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ key: 'private-test-session' })),
    ),
  )
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('speech smoke diagnostics', () => {
  it.each([
    [
      () => new Response(null, { headers: { 'Content-Type': 'audio/pcm' } }),
      'Streaming response body is missing',
    ],
    [
      () =>
        new Response(new Uint8Array(), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
      'Speech stream returned no audio',
    ],
    [
      () =>
        new Response(new Uint8Array([0]), {
          headers: { 'Content-Type': 'audio/pcm' },
        }),
      'Speech stream ended with an incomplete PCM sample',
    ],
  ])(
    'identifies an invalid audio response without printing credentials',
    async (response, message) => {
      createSpeech.mockImplementation(async () => response())
      await import('../../scripts/smoke-speech.mjs')
      await vi.waitFor(() => expect(stderr).toHaveBeenCalledOnce())
      const output = String(stderr.mock.calls[0][0])
      expect(JSON.parse(output)).toMatchObject({ name: 'AssertionError' })
      expect(JSON.parse(output).check).toContain(message)
      expect(output).not.toContain('private-test-session')
      expect(process.exitCode).toBe(1)
    },
  )

  it('does not log raw SDK errors that may contain request details', async () => {
    createSpeech.mockRejectedValue(
      Object.assign(new Error('private request details'), { status: 429 }),
    )
    await import('../../scripts/smoke-speech.mjs')
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledOnce())
    const output = String(stderr.mock.calls[0][0])
    expect(JSON.parse(output)).toMatchObject({ status: 429 })
    expect(output).not.toContain('private')
  })
})
