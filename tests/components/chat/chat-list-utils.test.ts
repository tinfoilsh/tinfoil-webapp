import { updatedLabel } from '@/components/chat/chat-list-utils'
import { describe, expect, it } from 'vitest'

describe('updatedLabel', () => {
  const now = Date.parse('2026-10-28T12:00:00Z')

  it('dates a project by the time the harness gave', () => {
    expect(updatedLabel('2026-10-28T08:59:59.123456Z', now)).toBe(
      'Updated 3h ago',
    )
  })

  it('shows nothing for a project without a time', () => {
    expect(updatedLabel(undefined, now)).toBeNull()
    expect(updatedLabel('', now)).toBeNull()
  })
})
