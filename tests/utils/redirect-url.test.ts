import { stripMessageMarkers } from '@/utils/redirect-url'
import { describe, expect, it } from 'vitest'

describe('stripMessageMarkers', () => {
  it.each([
    ['/?q=hello+world', '/'],
    ['/newchat?q=secret', '/newchat'],
    ['/#send=c2VjcmV0', '/'],
    ['/?q=secret#send=c2VjcmV0', '/'],
    ['/newchat?q=secret&view=compact#send=x', '/newchat?view=compact'],
  ])('removes message markers from %s', (input, expected) => {
    expect(stripMessageMarkers(input)).toBe(expected)
  })

  it.each([
    '/',
    '/chat/abc',
    '/c/chat-1?view=compact#bottom',
    '/settings#settings/privacy',
    '/project/p1/chat/c1?tab=files',
  ])('leaves %s untouched', (path) => {
    expect(stripMessageMarkers(path)).toBe(path)
  })
})
