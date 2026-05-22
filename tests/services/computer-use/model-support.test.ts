import { resolveAdapter } from '@/services/computer-use/adapter'
import { computerUseSupport } from '@/services/computer-use/model-support'
import { describe, expect, it } from 'vitest'

describe('resolveAdapter', () => {
  it('recognizes Kimi', () => {
    const r = resolveAdapter('kimi-k2-6')
    expect(r.recognized).toBe(true)
    expect(r.family).toBe('kimi')
    expect(r.adapter.systemPrompt).toContain('MUST call the `computer` tool')
  })

  it('recognizes Qwen-VL variants', () => {
    expect(resolveAdapter('qwen3-vl').recognized).toBe(true)
    expect(resolveAdapter('Qwen2.5-VL-72B').recognized).toBe(true)
  })

  it('falls back to the default adapter for unrecognized models', () => {
    const r = resolveAdapter('some-new-vlm-9000')
    expect(r.recognized).toBe(false)
    expect(r.family).toBe('default')
    expect(r.adapter).toBeDefined() // best-effort, still usable
  })
})

describe('computerUseSupport', () => {
  it('offers computer use for a recognized vision model with no caveats', () => {
    const s = computerUseSupport({ modelName: 'kimi-k2-6', multimodal: true })
    expect(s).toMatchObject({
      supported: true,
      recognized: true,
      family: 'kimi',
    })
    expect(s.reasons).toEqual([])
  })

  it('does NOT offer computer use for a non-vision model', () => {
    const s = computerUseSupport({
      modelName: 'gpt-oss-120b',
      multimodal: false,
    })
    expect(s.supported).toBe(false)
    expect(s.reasons[0]).toMatch(/vision-capable/i)
  })

  it('treats a missing multimodal flag as non-vision (default-deny)', () => {
    expect(computerUseSupport({ modelName: 'mystery-model' }).supported).toBe(
      false,
    )
  })

  it('offers but flags constraints for an unrecognized vision model', () => {
    const s = computerUseSupport({
      modelName: 'some-new-vlm-9000',
      multimodal: true,
    })
    expect(s.supported).toBe(true)
    expect(s.recognized).toBe(false)
    expect(s.reasons[0]).toMatch(/not specifically tuned|unreliable/i)
  })
})
