import { isoTime, upgradeMessages } from '@/services/harness/legacy'
import { describe, expect, it } from 'vitest'
import cases from '../../fixtures/legacy-upgrade/cases.json'
// Produced by running the harness's legacy.go (upgradeTimeline and
// upgradeAttachments, with the message loop of normalizeThread) on cases.json.
import expected from '../../fixtures/legacy-upgrade/expected.json'

describe('legacy transcript upgrade', () => {
  it.each(cases.map((thread, index) => [thread.id, thread, index] as const))(
    'upgrades %s exactly as the harness does',
    (_, thread, index) => {
      expect(
        upgradeMessages(thread.id, thread.createdAt, thread.messages),
      ).toEqual(expected[index])
    },
  )

  it('reads Date timestamps from IndexedDB rows like their ISO strings', () => {
    const [fromDate] = upgradeMessages('chat', undefined, [
      {
        role: 'user',
        content: 'hi',
        timestamp: new Date('2026-03-04T05:06:07.890Z'),
      },
    ])
    expect(fromDate.createdAt).toBe('2026-03-04T05:06:07.89Z')
  })

  it('leaves messages already in the harness format unchanged', () => {
    const [stored] = upgradeMessages('chat', undefined, expected[0])
    const upgradedAgain = upgradeMessages('chat', undefined, [stored])
    expect(upgradedAgain).toEqual([stored])
  })

  it('does not modify the stored rows it reads', () => {
    const source = structuredClone(cases[0].messages)
    upgradeMessages(cases[0].id, cases[0].createdAt, source)
    expect(source).toEqual(cases[0].messages)
  })

  it.each([
    ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z'],
    ['2026-01-01T10:00:00.120+02:00', '2026-01-01T08:00:00.12Z'],
    ['2026-01-01T00:00:00.123456789Z', '2026-01-01T00:00:00.123456789Z'],
    ['2024-02-29T10:00:00+02:00', '2024-02-29T08:00:00Z'],
    ['2026-02-29T10:00:00+02:00', '2026-02-29T10:00:00+02:00'],
    ['2026-04-31T00:00:00Z', '2026-04-31T00:00:00Z'],
    ['2026-01-01T24:00:00Z', '2026-01-01T24:00:00Z'],
    ['2026-01-01T00:00:60Z', '2026-01-01T00:00:60Z'],
    ['2026-01-01T00:00:00+24:00', '2025-12-31T00:00:00Z'],
    ['2026-01-01t00:00:00z', '2026-01-01t00:00:00z'],
    ['not a date', 'not a date'],
    [1700000000000, '2023-11-14T22:13:20Z'],
    [1700000000123, '2023-11-14T22:13:20.123Z'],
    [0, ''],
    [-5, ''],
    [Number.POSITIVE_INFINITY, ''],
    [undefined, ''],
  ])('formats %s as Go does', (input, output) => {
    expect(isoTime(input)).toBe(output)
  })
})
