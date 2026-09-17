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
  overlayProfileChanges,
  reconcileDirtyProfileWithoutBaseline,
} from '@/services/cloud/profile-merge'
import type { ProfileData } from '@/services/cloud/profile-sync'
import { MAX_PINNED_CHATS } from '@/services/storage/pinned-chats'
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
      additionalContext: 'old-prompt',
      fieldClocks: {
        nickname: { v: 5, w: 'A' },
        additionalContext: { v: 1, w: 'A' },
      },
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    const remote = trusted({
      nickname: 'remote-name',
      additionalContext: 'new-prompt',
      fieldClocks: {
        nickname: { v: 2, w: 'B' },
        additionalContext: { v: 9, w: 'B' },
      },
      updatedAt: '2024-01-02T00:00:00.000Z',
    })

    const { merged, adoptedRemote } = mergeProfiles({ local, remote })

    // local nickname (clock 5) beats remote (clock 2); remote prompt
    // (clock 9) beats local (clock 1). Neither edit is lost.
    expect(merged.nickname).toBe('local-name')
    expect(merged.additionalContext).toBe('new-prompt')
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
      additionalContext: 'my prompt',
      traits: ['curious'],
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    const remote: ProfileData = {
      nickname: '',
      additionalContext: '',
      traits: [],
      updatedAt: '2024-01-02T00:00:00.000Z',
    }

    const { merged, adoptedRemote } = mergeProfiles({ local, remote })

    expect(merged.nickname).toBe('real-user')
    expect(merged.additionalContext).toBe('my prompt')
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
    expect(isProfilePopulated({ additionalContext: 'hi' })).toBe(true)
    expect(isProfilePopulated({ pinnedChatIds: ['chat-a'] })).toBe(true)
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
      pixelateSidebarChatTitlesEnabled: true,
    }
    const local: ProfileData = {
      nickname: 'b',
      traits: ['x', 'y'],
      thinkingEnabled: true,
      webSearchAvailable: false,
      pixelateSidebarChatTitlesEnabled: false,
    }
    const fields = changedProfileFields(local, baseline)
    expect(fields.sort()).toEqual([
      'nickname',
      'pixelateSidebarChatTitlesEnabled',
      'traits',
      'webSearchAvailable',
    ])
  })
})

describe('overlayProfileChanges', () => {
  it('overlays only fields changed between local snapshots', () => {
    const result = overlayProfileChanges(
      { nickname: 'Remote', profession: 'Researcher', version: 4 },
      { nickname: 'Before', profession: 'Engineer', version: 1 },
      { nickname: 'After', profession: 'Engineer', version: 99 },
    )

    expect(result.profile).toEqual({
      nickname: 'After',
      profession: 'Researcher',
      version: 4,
    })
    expect(result.changedFields).toEqual(['nickname'])
  })

  it('removes a field cleared during the fetch', () => {
    const result = overlayProfileChanges(
      { additionalContext: 'Remote prompt', version: 2 },
      { additionalContext: 'Before prompt' },
      {},
    )

    expect(result.profile).toEqual({ version: 2 })
    expect(result.changedFields).toEqual(['additionalContext'])
  })
})

describe('reconcileDirtyProfileWithoutBaseline', () => {
  it('preserves local pins without replacing remote settings', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: {
        nickname: 'Remote',
        themeMode: 'light',
        profession: 'Researcher',
        version: 4,
      },
      localBeforeFetch: {
        nickname: 'Remote',
        themeMode: 'light',
        profession: 'Researcher',
        pixelateSidebarChatTitlesEnabled: false,
        pinnedChatIds: ['chat-a'],
      },
      localAfterFetch: {
        nickname: 'Remote',
        themeMode: 'light',
        profession: 'Researcher',
        pixelateSidebarChatTitlesEnabled: false,
        pinnedChatIds: ['chat-a'],
      },
    })

    expect(profile).toEqual({
      nickname: 'Remote',
      themeMode: 'light',
      profession: 'Researcher',
      pixelateSidebarChatTitlesEnabled: false,
      pinnedChatIds: ['chat-a'],
      version: 4,
    })
  })

  it('preserves an explicit local clear when the remote has pins', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: {
        nickname: 'Remote',
        pinnedChatIds: ['remote-chat'],
        version: 4,
      },
      localBeforeFetch: { pinnedChatIds: [] },
      localAfterFetch: { pinnedChatIds: [] },
    })

    expect(profile?.pinnedChatIds).toEqual([])
  })

  it.each([
    'pixelateSidebarChatTitlesEnabled',
    'browserTabChatTitleEnabled',
  ] as const)(
    'recovers migration-safe field %s when the remote omits it',
    (field) => {
      const profile = reconcileDirtyProfileWithoutBaseline({
        remote: { nickname: 'Remote', version: 4 },
        localBeforeFetch: { nickname: 'Remote', [field]: false },
        localAfterFetch: { nickname: 'Remote', [field]: false },
      })

      expect(profile?.[field]).toBe(false)
    },
  )

  it('overlays settings changed while the remote profile was loading', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: {
        nickname: 'Remote',
        profession: 'Researcher',
        pinnedChatIds: ['remote-chat'],
        version: 4,
      },
      localBeforeFetch: {
        nickname: 'Remote',
        profession: 'Researcher',
        pinnedChatIds: ['chat-a'],
      },
      localAfterFetch: {
        nickname: 'Changed during fetch',
        profession: 'Researcher',
        pinnedChatIds: ['chat-b', 'chat-a'],
      },
    })

    expect(profile).toMatchObject({
      nickname: 'Changed during fetch',
      profession: 'Researcher',
      pinnedChatIds: ['chat-b', 'chat-a', 'remote-chat'],
    })
  })

  it('accepts matching remote pins', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: { nickname: 'Remote', pinnedChatIds: ['chat-a'] },
      localBeforeFetch: {
        nickname: 'Remote',
        pinnedChatIds: ['chat-a'],
      },
      localAfterFetch: {
        nickname: 'Remote',
        pinnedChatIds: ['chat-a'],
      },
    })

    expect(profile?.pinnedChatIds).toEqual(['chat-a'])
  })

  it('rejects reconciliation without pins or with overlapping changes', () => {
    expect(
      reconcileDirtyProfileWithoutBaseline({
        remote: { nickname: 'Remote' },
        localBeforeFetch: { nickname: 'Local' },
        localAfterFetch: { nickname: 'Local' },
      }),
    ).toBeNull()
    expect(
      reconcileDirtyProfileWithoutBaseline({
        remote: { nickname: 'Remote' },
        localBeforeFetch: {
          nickname: 'Remote',
          profession: 'Researcher',
          pinnedChatIds: ['chat-a'],
        },
        localAfterFetch: {
          nickname: 'Remote',
          profession: 'Researcher',
          pinnedChatIds: ['chat-a'],
        },
      }),
    ).toBeNull()
    expect(
      reconcileDirtyProfileWithoutBaseline({
        remote: { nickname: 'Remote' },
        localBeforeFetch: {
          nickname: 'Local',
          pinnedChatIds: ['chat-a'],
        },
        localAfterFetch: {
          nickname: 'Local',
          pinnedChatIds: ['chat-a'],
        },
      }),
    ).toBeNull()
  })

  it('combines divergent pins when no baseline exists', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: { pinnedChatIds: ['remote-chat', 'shared-chat'] },
      localBeforeFetch: { pinnedChatIds: ['local-chat', 'shared-chat'] },
      localAfterFetch: { pinnedChatIds: ['local-chat', 'shared-chat'] },
    })

    expect(profile?.pinnedChatIds).toEqual([
      'local-chat',
      'shared-chat',
      'remote-chat',
    ])
  })

  it('preserves pins removed while the remote profile was loading', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: { pinnedChatIds: ['removed-chat', 'remote-chat'] },
      localBeforeFetch: { pinnedChatIds: ['removed-chat', 'local-chat'] },
      localAfterFetch: { pinnedChatIds: ['local-chat'] },
    })

    expect(profile?.pinnedChatIds).toEqual(['local-chat', 'remote-chat'])
  })

  it('preserves remote-only pins when the last local pin is removed', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: { pinnedChatIds: ['local-chat', 'remote-chat'] },
      localBeforeFetch: { pinnedChatIds: ['local-chat'] },
      localAfterFetch: { pinnedChatIds: [] },
    })

    expect(profile?.pinnedChatIds).toEqual(['remote-chat'])
  })

  it('does not treat a missing local snapshot as an explicit clear', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: {
        pixelateSidebarChatTitlesEnabled: true,
        pinnedChatIds: ['remote-chat'],
      },
      localBeforeFetch: { pixelateSidebarChatTitlesEnabled: true },
      localAfterFetch: {
        pixelateSidebarChatTitlesEnabled: true,
        pinnedChatIds: [],
      },
    })

    expect(profile?.pinnedChatIds).toEqual(['remote-chat'])
  })

  it('combines a first pin added while the remote profile was loading', () => {
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: {
        pixelateSidebarChatTitlesEnabled: true,
        pinnedChatIds: ['remote-chat'],
      },
      localBeforeFetch: { pixelateSidebarChatTitlesEnabled: true },
      localAfterFetch: {
        pixelateSidebarChatTitlesEnabled: true,
        pinnedChatIds: ['local-chat'],
      },
    })

    expect(profile?.pinnedChatIds).toEqual(['local-chat', 'remote-chat'])
  })

  it('rejects a baseline-free pin merge that exceeds the limit', () => {
    const localPins = Array.from(
      { length: MAX_PINNED_CHATS },
      (_, index) => `local-${index}`,
    )
    const profile = reconcileDirtyProfileWithoutBaseline({
      remote: { pinnedChatIds: ['remote-chat'] },
      localBeforeFetch: { pinnedChatIds: localPins },
      localAfterFetch: { pinnedChatIds: localPins },
    })

    expect(profile).toBeNull()
  })
})

describe('mergeProfilesThreeWay', () => {
  it('preserves local pins when an older remote omits the field', () => {
    const result = mergeProfilesThreeWay({
      baseline: { pinnedChatIds: ['chat-a'] },
      local: { pinnedChatIds: ['chat-a'] },
      remote: { nickname: 'Remote' },
    })

    expect(result.merged.pinnedChatIds).toEqual(['chat-a'])
  })

  it('preserves locally edited pins when an older remote omits the field', () => {
    const result = mergeProfilesThreeWay({
      baseline: { pinnedChatIds: ['chat-a'] },
      local: { pinnedChatIds: ['chat-b', 'chat-a'] },
      remote: { nickname: 'Remote' },
    })

    expect(result.merged.pinnedChatIds).toEqual(['chat-b', 'chat-a'])
    expect(result.conflicts).not.toContain('pinnedChatIds')
  })

  it('adopts an explicit remote clear of pins', () => {
    const result = mergeProfilesThreeWay({
      baseline: { pinnedChatIds: ['chat-a'] },
      local: { pinnedChatIds: ['chat-a'] },
      remote: { pinnedChatIds: [] },
    })

    expect(result.merged.pinnedChatIds).toEqual([])
  })

  it('adopts a remote default preset when the baseline predates the field', () => {
    // The baseline came from an older client that never wrote the field,
    // while this client serializes the unset default as ''. Both mean
    // "no default" so the remote's new choice must win without conflict.
    const result = mergeProfilesThreeWay({
      baseline: { nickname: 'Ada' },
      local: { nickname: 'Ada', defaultPromptPresetId: '' },
      remote: {
        nickname: 'Ada',
        defaultPromptPresetId: 'user:abc',
        version: 2,
      },
    })

    expect(result.merged.defaultPromptPresetId).toBe('user:abc')
    expect(result.conflicts).toEqual([])
    expect(
      changedProfileFields(
        { nickname: 'Ada', defaultPromptPresetId: '' },
        { nickname: 'Ada' },
      ),
    ).toEqual([])
  })

  it('propagates an explicit default preset clear', () => {
    const result = mergeProfilesThreeWay({
      baseline: { defaultPromptPresetId: 'user:abc' },
      local: { defaultPromptPresetId: 'user:abc' },
      remote: { defaultPromptPresetId: '', version: 2 },
    })

    expect(result.merged.defaultPromptPresetId).toBe('')
    expect(result.conflicts).toEqual([])
  })

  it('adopts populated remote fields when local stayed empty', () => {
    const result = mergeProfilesThreeWay({
      baseline: { nickname: '', additionalContext: '' },
      local: { nickname: '', additionalContext: '' },
      remote: {
        nickname: 'Ada',
        additionalContext: 'Be concise',
        version: 2,
      },
    })

    expect(result.merged.nickname).toBe('Ada')
    expect(result.merged.additionalContext).toBe('Be concise')
    expect(result.conflicts).toEqual([])
  })

  it('retains baseline preferences when migrated local keys are absent', () => {
    const result = mergeProfilesThreeWay({
      baseline: { language: 'Spanish', isUsingPersonalization: false },
      local: {},
      remote: {
        language: 'Spanish',
        isUsingPersonalization: false,
        version: 2,
      },
    })

    expect(result.merged.language).toBe('Spanish')
    expect(result.merged.isUsingPersonalization).toBe(false)
    expect(result.conflicts).toEqual([])
  })

  it('adopts remote preference updates when migrated local keys are absent', () => {
    const result = mergeProfilesThreeWay({
      baseline: { language: 'Spanish', isUsingPersonalization: true },
      local: {},
      remote: { language: 'French', isUsingPersonalization: false, version: 2 },
    })

    expect(result.merged.language).toBe('French')
    expect(result.merged.isUsingPersonalization).toBe(false)
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
      baseline: { additionalContext: 'Use headings' },
      local: { additionalContext: '' },
      remote: { additionalContext: 'Use headings', version: 2 },
    })

    expect(result.merged.additionalContext).toBe('')
    expect(result.conflicts).toEqual([])
  })

  it('preserves pixelation preferences omitted by older profiles', () => {
    const result = mergeProfilesThreeWay({
      baseline: { pixelateSidebarChatTitlesEnabled: false },
      local: { pixelateSidebarChatTitlesEnabled: false },
      remote: { version: 2 },
    })

    expect(result.merged.pixelateSidebarChatTitlesEnabled).toBe(false)
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
