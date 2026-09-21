import { describe, expect, it } from 'vitest'
import { parseProxyOrigin } from '../../scripts/dev-http-proxy.mjs'

describe('development HTTP proxy upstream validation', () => {
  it('accepts HTTPS upstreams', () => {
    expect(parseProxyOrigin('https://api.tinfoil.sh/path')).toBe(
      'https://api.tinfoil.sh',
    )
  })

  it.each([
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ])('accepts loopback HTTP upstream %s', (input, expected) => {
    expect(parseProxyOrigin(input)).toBe(expected)
  })

  it.each([
    'http://api.tinfoil.sh',
    'http://192.168.1.20:8080',
    'ftp://localhost',
    'not a url',
  ])('rejects insecure or invalid upstream %s', (input) => {
    expect(parseProxyOrigin(input)).toBeNull()
  })
})
