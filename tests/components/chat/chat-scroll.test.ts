import {
  getChatContentBottomScrollTop,
  getDistanceFromChatContentBottom,
} from '@/components/chat/chat-scroll'
import { describe, expect, it } from 'vitest'

describe('chat scrolling', () => {
  it('targets the end of conversation content instead of the spacer', () => {
    expect(getChatContentBottomScrollTop(2400, 800, 500)).toBe(1100)
  })

  it('measures distance from conversation content instead of the spacer', () => {
    expect(getDistanceFromChatContentBottom(2400, 900, 800, 500)).toBe(200)
  })
})
