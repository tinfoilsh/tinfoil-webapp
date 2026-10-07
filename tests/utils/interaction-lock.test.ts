import { acquireInteractionLock } from '@/utils/interaction-lock'
import { beforeEach, describe, expect, it } from 'vitest'

describe('interaction lock', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps an element locked until every owner releases it', () => {
    const appRoot = document.createElement('div')
    document.body.appendChild(appRoot)

    const releaseFirst = acquireInteractionLock([appRoot], {
      ariaHidden: true,
    })
    const releaseSecond = acquireInteractionLock([appRoot], {
      ariaHidden: true,
    })

    releaseFirst()
    expect(appRoot.hasAttribute('inert')).toBe(true)
    expect(appRoot.getAttribute('aria-hidden')).toBe('true')

    releaseSecond()
    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(appRoot.hasAttribute('aria-hidden')).toBe(false)
  })

  it('restores attributes that existed before the lock', () => {
    const appRoot = document.createElement('div')
    appRoot.setAttribute('inert', '')
    appRoot.setAttribute('aria-hidden', 'false')
    document.body.appendChild(appRoot)

    const release = acquireInteractionLock([appRoot], { ariaHidden: true })
    expect(appRoot.getAttribute('aria-hidden')).toBe('true')
    release()

    expect(appRoot.hasAttribute('inert')).toBe(true)
    expect(appRoot.getAttribute('aria-hidden')).toBe('false')
  })

  it('allows release to be called more than once', () => {
    const appRoot = document.createElement('div')
    document.body.appendChild(appRoot)

    const release = acquireInteractionLock([appRoot])
    const releaseOther = acquireInteractionLock([appRoot])
    release()
    release()

    expect(appRoot.hasAttribute('inert')).toBe(true)
    releaseOther()
    expect(appRoot.hasAttribute('inert')).toBe(false)
  })
})
