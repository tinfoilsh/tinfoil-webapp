/**
 * Profile Merge Tests
 *
 * Field-level conflict resolution for profile sync. The merge must:
 * - keep each side's freshest field by edit clock when both are trusted
 * - fall back to whole-blob updatedAt when clocks are absent/untrusted
 * - never let an empty/default blob wipe a populated profile on fallback
 * - converge: merging in either direction yields the same field values
 */

import {
  changedProfileFields,
  isProfilePopulated,
  mergeProfiles,
  mergeProfilesThreeWay,
} from '@/services/cloud/profile-merge'
import type { ProfileData } from '@/services/cloud/profile-sync'
import { describe, expect, it } from 'vitest'

// A trusted blob has clockVersion === version, so its field clocks are
// honored during the merge.
function trusted(p: ProfileData): ProfileData {
  return { ...p, version: 10, clockVersion: 10 }
}

describe('mergeProfiles', () => {
  it('keeps each side’s field with the higher clock', () => {
    const local = trusted({
      nickname: 'local-name',
      customSystemPrompt: 'old-prompt',
      fieldClocks: {
        nickname: { v: 5, w: 'A' },
        customSystemPrompt: { v: 1, w: 'A' },
      },
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    const remote = trusted({
      nickname: 'remote-name',
      customSystemPrompt: 'new-prompt',
      fieldClocks: {
        nickname: { v: 2, w: 'B' },
        customSystemPrompt: { v: 9, w: 'B' },
      },
      updatedAt: '2024-01-02T00:00:00.000Z',
    })

    const { merged, adoptedRemote } = mergeProfiles({ local, remote })

    // local nickname (clock 5) beats remote (clock 2); remote prompt
    // (clock 9) beats local (clock 1). Neither edit is lost.
    expect(merged.nickname).toBe('local-name')
    expect(merged.customSystemPrompt).toBe('new-prompt')
    expect(adoptedRemote).toBe(true)
  })

  it('converges regardless of merge direction', () => {
    const local = trusted({
      nickname: 'local-name',
      profession: 'old-job',
      fieldClocks: {
        nickname: { v: 5, w: 'A' },
        profession: { v: 1, w: 'A' },
      },
    })
    const remote = trusted({
      nickname: 'remote-name',
      profession: 'new-job',
      fieldClocks: {
        nickname: { v: 2, w: 'B' },
        profession: { v: 9, w: 'B' },
      },
    })

    const a = mergeProfiles({ local, remote }).merged
    const b = mergeProfiles({ local: remote, remote: local }).merged

    expect(a.nickname).toBe(b.nickname)
    expect(a.profession).toBe(b.profession)
    expect(a.nickname).toBe('local-name')
    expect(a.profession).toBe('new-job')
  })

  it('refuses to let an empty remote wipe a populated local on fallback', () => {
    // No trusted clocks -> fallback path. Remote is newer by wall clock
    // but empty; the populated local profile must survive.
    const local: ProfileData = {
      nickname: 'real-user',
      customSystemPrompt: 'my prompt',
      traits: ['curious'],
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const remote: ProfileData = {
      nickname: '',
      customSystemPrompt: '',
      traits: [],
      updatedAt: '2024-01-02T00:00:00.000Z',
    }

    const { merged, adoptedRemote } = mergeProfiles({ local, remote })

    expect(merged.nickname).toBe('real-user')
    expect(merged.customSystemPrompt).toBe('my prompt')
    expect(adoptedRemote).toBe(false)
  })

  it('does not carry untrusted local clocks into the merged output', () => {
    // Local clocks are untrusted (clockVersion !== version). They must
    // not survive into the merge, or the next push would re-stamp them
    // as trusted and corrupt future conflict resolution.
    const local: ProfileData = {
      nickname: 'local',
      profession: 'local-job',
      version: 4,
      clockVersion: 2,
      fieldClocks: {
        nickname: { v: 99, w: 'A' },
        profession: { v: 99, w: 'A' },
      },
      updatedAt: '2024-01-02T00:00:00.000Z',
    }
    // Remote omits profession, and local wins nickname by updatedAt.
    const remote: ProfileData = {
      nickname: 'remote',
      version: 5,
      clockVersion: 2,
      fieldClocks: { nickname: { v: 1, w: 'B' } },
      updatedAt: '2024-01-01T00:00:00.000Z',
    }

    const { merged } = mergeProfiles({ local, remote })

    expect(merged.nickname).toBe('local')
    expect(merged.profession).toBe('local-job')
    // No trusted clock existed for either field, so none is carried.
    expect(merged.fieldClocks).toBeUndefined()
  })

  it('falls back to updatedAt when clocks are untrusted', () => {
    // clockVersion !== version means a clock-unaware client wrote since,
    // so the field clocks are ignored and the newer blob wins wholesale.
    const local: ProfileData = {
      nickname: 'local',
      version: 4,
      clockVersion: 2,
      fieldClocks: { nickname: { v: 99, w: 'A' } },
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const remote: ProfileData = {
      nickname: 'remote',
      version: 5,
      clockVersion: 2,
      fieldClocks: { nickname: { v: 1, w: 'B' } },
      updatedAt: '2024-01-02T00:00:00.000Z',
    }

    const { merged } = mergeProfiles({ local, remote })

    // Despite local's huge clock, it is untrusted; newer remote wins.
    expect(merged.nickname).toBe('remote')
  })
})

describe('isProfilePopulated', () => {
  it('is true when any user content is present', () => {
    expect(isProfilePopulated({ nickname: 'x' })).toBe(true)
    expect(isProfilePopulated({ traits: ['a'] })).toBe(true)
    expect(isProfilePopulated({ customSystemPrompt: 'hi' })).toBe(true)
  })

  it('is false for empty or default-only profiles', () => {
    expect(isProfilePopulated(null)).toBe(false)
    expect(
      isProfilePopulated({
        nickname: '',
        traits: [],
        themeMode: 'system',
        thinkingEnabled: true,
      }),
    ).toBe(false)
  })
})

describe('changedProfileFields', () => {
  it('lists every field when there is no baseline', () => {
    const fields = changedProfileFields({ nickname: 'a' }, null)
    expect(fields).toContain('nickname')
    expect(fields.length).toBeGreaterThan(1)
  })

  it('detects primitive and array changes only', () => {
    const baseline: ProfileData = {
      nickname: 'a',
      traits: ['x'],
      thinkingEnabled: true,
      webSearchAvailable: true,
    }
    const local: ProfileData = {
      nickname: 'b',
      traits: ['x', 'y'],
      thinkingEnabled: true,
      webSearchAvailable: false,
    }
    const fields = changedProfileFields(local, baseline)
    expect(fields.sort()).toEqual(['nickname', 'traits', 'webSearchAvailable'])
  })
})

describe('mergeProfilesThreeWay', () => {
  it('adopts populated remote fields when local stayed empty', () => {
    const result = mergeProfilesThreeWay({
      baseline: { nickname: '', customSystemPrompt: '' },
      local: { nickname: '', customSystemPrompt: '' },
      remote: {
        nickname: 'Ada',
        customSystemPrompt: 'Be concise',
        version: 2,
      },
    })

    expect(result.merged.nickname).toBe('Ada')
    expect(result.merged.customSystemPrompt).toBe('Be concise')
    expect(result.conflicts).toEqual([])
  })

  it('combines independent edits from both devices', () => {
    const result = mergeProfilesThreeWay({
      baseline: { nickname: 'Ada', profession: 'Engineer' },
      local: { nickname: 'Grace', profession: 'Engineer' },
      remote: { nickname: 'Ada', profession: 'Researcher', version: 2 },
    })

    expect(result.merged.nickname).toBe('Grace')
    expect(result.merged.profession).toBe('Researcher')
    expect(result.conflicts).toEqual([])
  })

  it('keeps the higher clock when concurrent edits converge', () => {
    const result = mergeProfilesThreeWay({
      baseline: trusted({
        nickname: 'Ada',
        fieldClocks: { nickname: { v: 1, w: 'A' } },
      }),
      local: trusted({
        nickname: 'Grace',
        fieldClocks: { nickname: { v: 4, w: 'A' } },
      }),
      remote: trusted({
        nickname: 'Grace',
        fieldClocks: { nickname: { v: 7, w: 'B' } },
      }),
    })

    expect(result.merged.nickname).toBe('Grace')
    expect(result.merged.fieldClocks?.nickname).toEqual({ v: 7, w: 'B' })
    expect(result.conflicts).toEqual([])
  })

  it('preserves an intentional local reset', () => {
    const result = mergeProfilesThreeWay({
      baseline: { customSystemPrompt: 'Use headings' },
      local: { customSystemPrompt: '' },
      remote: { customSystemPrompt: 'Use headings', version: 2 },
    })

    expect(result.merged.customSystemPrompt).toBe('')
    expect(result.conflicts).toEqual([])
  })

  it('retains local data and reports an ambiguous conflict', () => {
    const result = mergeProfilesThreeWay({
      baseline: { nickname: 'Ada' },
      local: { nickname: 'Grace' },
      remote: { nickname: 'Lin', version: 2 },
    })

    expect(result.merged.nickname).toBe('Grace')
    expect(result.conflicts).toEqual(['nickname'])
  })
})
