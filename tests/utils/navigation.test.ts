import { isPlainPrimaryClick } from '@/utils/navigation'
import { describe, expect, it } from 'vitest'

describe('navigation utilities', () => {
  it('only classifies unmodified primary clicks as in-place navigation', () => {
    const primaryClick = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }

    expect(isPlainPrimaryClick(primaryClick)).toBe(true)
    expect(isPlainPrimaryClick({ ...primaryClick, button: 1 })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, ctrlKey: true })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, metaKey: true })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, shiftKey: true })).toBe(false)
    expect(isPlainPrimaryClick({ ...primaryClick, altKey: true })).toBe(false)
  })
})
