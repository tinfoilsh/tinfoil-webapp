import { resizeChatViewport } from '@/components/chat/chat-scroll'
import { CONSTANTS } from '@/components/chat/constants'
import { expect, it } from 'vitest'

const COMPOSER_ROOM_PX = 100
const MESSAGES_HEIGHT_PX = 2000
const KEYBOARD_CLOSED_PX = 700
const KEYBOARD_OPEN_PX = 400

// A conversation laid out as a browser lays it out: the view is as tall as
// the test makes it, the messages keep their height, the room under a new
// prompt follows the view, and the view never scrolls past the end.
function conversation({
  promptOffset,
  anchored = false,
  welcome = false,
}: {
  // Where the latest prompt starts within the messages.
  promptOffset?: number
  anchored?: boolean
  welcome?: boolean
} = {}) {
  let height = KEYBOARD_CLOSED_PX
  let scrolled = 0
  const written: number[] = []
  const container = document.createElement('div')
  const spacerHeight = () => Math.max(0, height - COMPOSER_ROOM_PX)
  const scrollHeight = () =>
    Math.max(height, MESSAGES_HEIGHT_PX + (anchored ? spacerHeight() : 0))
  const end = () => scrollHeight() - height
  Object.defineProperties(container, {
    clientHeight: { get: () => height },
    scrollHeight: { get: scrollHeight },
    scrollTop: {
      get: () => Math.min(scrolled, end()),
      set: (top: number) => {
        written.push(top)
        scrolled = Math.max(0, Math.min(top, end()))
      },
    },
  })
  if (!welcome) {
    const prompt = document.createElement('div')
    prompt.dataset.messageRole = 'user'
    prompt.getBoundingClientRect = () =>
      new DOMRect(0, (promptOffset ?? 0) - container.scrollTop, 0, 0)
    container.append(prompt)
  }
  if (anchored) {
    const spacer = document.createElement('div')
    spacer.dataset.spacer = ''
    Object.defineProperty(spacer, 'offsetHeight', { get: spacerHeight })
    container.append(spacer)
  }
  return {
    container,
    scrollTo(top: number) {
      container.scrollTop = top
      written.length = 0
    },
    // The scroll positions written while the view changed height.
    resize(next: number) {
      resizeChatViewport(container, () => {
        height = next
      })
      return written.splice(0)
    },
  }
}

it.each([
  { reading: 'the end of the chat', closed: 1300, open: 1600 },
  { reading: 'earlier messages', closed: 800, open: 1100 },
])(
  'keeps what is above the composer there as the keyboard opens and closes on $reading',
  ({ closed, open }) => {
    const chat = conversation()
    chat.scrollTo(closed)

    chat.resize(KEYBOARD_OPEN_PX)
    expect(chat.container.scrollTop).toBe(open)

    chat.resize(KEYBOARD_CLOSED_PX)
    expect(chat.container.scrollTop).toBe(closed)
  },
)

it('leaves a new prompt at the top of the view while its reply still fits', () => {
  const promptOffset = 1700
  const atPrompt = promptOffset - CONSTANTS.CHAT_MESSAGE_TOP_GAP_PX
  const chat = conversation({ promptOffset, anchored: true })
  chat.scrollTo(atPrompt)

  expect(chat.resize(KEYBOARD_OPEN_PX)).toEqual([])
  expect(chat.resize(KEYBOARD_CLOSED_PX)).toEqual([])
  expect(chat.container.scrollTop).toBe(atPrompt)
})

it('shows the end of a reply the keyboard would cover, then returns to its prompt', () => {
  const promptOffset = 1500
  const atPrompt = promptOffset - CONSTANTS.CHAT_MESSAGE_TOP_GAP_PX
  const chat = conversation({ promptOffset, anchored: true })
  chat.scrollTo(atPrompt)

  chat.resize(KEYBOARD_OPEN_PX)
  expect(chat.container.scrollTop).toBe(MESSAGES_HEIGHT_PX - KEYBOARD_OPEN_PX)

  chat.resize(KEYBOARD_CLOSED_PX)
  expect(chat.container.scrollTop).toBe(atPrompt)
})

it('does not interrupt a new prompt that is still scrolling to the top', () => {
  const chat = conversation({ promptOffset: 1700, anchored: true })
  chat.resize(KEYBOARD_OPEN_PX)
  chat.scrollTo(1200)

  expect(chat.resize(KEYBOARD_CLOSED_PX)).toEqual([])
  expect(chat.resize(KEYBOARD_OPEN_PX)).toEqual([])
  expect(chat.container.scrollTop).toBe(1200)
})

it('leaves the welcome screen where it is', () => {
  const chat = conversation({ welcome: true })

  expect(chat.resize(KEYBOARD_OPEN_PX)).toEqual([])
  expect(chat.container.clientHeight).toBe(KEYBOARD_OPEN_PX)
})
