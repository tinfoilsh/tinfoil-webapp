import { FORK_TITLE_SUFFIX, forkChatTitle } from '@/constants/chat'
import { expect, it } from 'vitest'

it('does not stack the fork suffix when forking a fork', () => {
  expect(forkChatTitle(`Trip planning${FORK_TITLE_SUFFIX}`)).toBe(
    `Trip planning${FORK_TITLE_SUFFIX}`,
  )
  expect(forkChatTitle('')).toBe(`Untitled${FORK_TITLE_SUFFIX}`)
})
