import { analyticsExcluded } from '@/utils/analytics-routes'
import { describe, expect, it } from 'vitest'

describe('analyticsExcluded', () => {
  it.each([
    '/',
    '/newchat',
    '/newchat/',
    '/chat',
    '/chat/local/abc?x=1',
    '/share/abc#f',
    '/project/p1/chat/c1',
  ])('excludes %s', (path) => expect(analyticsExcluded(path)).toBe(true))
  it.each(['/project', '/project/p1', '/signin', '/no-such-page'])(
    'tracks %s',
    (path) => expect(analyticsExcluded(path)).toBe(false),
  )
})
