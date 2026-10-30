import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_DOCUMENT,
  PROTOCOL_TYPES,
  protocolTypes,
} from '../../scripts/sync-harness-protocol.mjs'

describe('harness protocol types', () => {
  it('are generated from the vendored protocol', async () => {
    expect(readFileSync(PROTOCOL_TYPES, 'utf8')).toBe(
      await protocolTypes(readFileSync(PROTOCOL_DOCUMENT, 'utf8')),
    )
  })
})
