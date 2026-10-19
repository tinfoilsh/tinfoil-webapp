import { canCommitProjectLoad } from '@/components/project/project-load-validity'
import { describe, expect, it, vi } from 'vitest'

describe('canCommitProjectLoad', () => {
  it('requires provider and caller generations to remain current', () => {
    const isCurrent = vi.fn(() => true)
    expect(canCommitProjectLoad(2, 2, 'project-a', 'project-a')).toBe(true)
    expect(
      canCommitProjectLoad(2, 3, 'project-a', 'project-a', isCurrent),
    ).toBe(false)
    expect(isCurrent).not.toHaveBeenCalled()
    expect(canCommitProjectLoad(2, 2, 'project-a', 'project-b')).toBe(false)
    expect(
      canCommitProjectLoad(2, 2, 'project-a', 'project-a', () => false),
    ).toBe(false)
  })
})
