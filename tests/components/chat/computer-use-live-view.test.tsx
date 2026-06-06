/**
 * Tests for ComputerUseLiveView's colour correction.
 *
 * Apple Virtualization.framework's VNC server emits BGR-ordered pixels and
 * ignores noVNC's RGB SetPixelFormat, so noVNC renders red<->blue swapped.
 * We correct it with an SVG feColorMatrix on the framebuffer canvas; this
 * guards that the swap matrix stays a true R<->B permutation.
 */
import { ComputerUseLiveView } from '@/components/chat/ComputerUseLiveView'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('ComputerUseLiveView colour correction', () => {
  it('defines an R<->B swap filter (matrix maps RGBA -> BGRA)', () => {
    const { container } = render(
      <ComputerUseLiveView
        sessionId="s1"
        // Never resolves: the connect effect parks on the token await, so
        // there's no noVNC import or late state update — we only assert the
        // static filter definition.
        getAccessToken={() => new Promise<string | null>(() => {})}
      />,
    )
    const filter = container.querySelector('#cua-vnc-rb-swap')
    expect(filter).toBeTruthy()
    // The lone child is the feColorMatrix (SVG tag names are case-sensitive,
    // so reach it positionally rather than by selector).
    const fe = filter?.firstElementChild
    expect(fe?.getAttribute('values')?.replace(/\s+/g, ' ').trim()).toBe(
      '0 0 1 0 0 0 1 0 0 0 1 0 0 0 0 0 0 0 1 0',
    )
  })
})
