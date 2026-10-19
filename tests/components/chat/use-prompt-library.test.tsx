import { usePromptLibrary } from '@/components/chat/hooks/use-prompt-library'
import { readUserPresets } from '@/components/chat/prompts/default-preset'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

const PROMPT = '<system>\nFix typos.\n</system>'

describe('usePromptLibrary chat settings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores a model and web search choice on a new preset', () => {
    const { result } = renderHook(() => usePromptLibrary())

    let id = ''
    act(() => {
      id = result.current.createUserPreset({
        name: 'Proofreader',
        description: '',
        systemPrompt: PROMPT,
        model: 'gpt-oss-120b',
        webSearchEnabled: false,
      }).id
    })

    const stored = readUserPresets().find((p) => p.id === id)
    expect(stored).toMatchObject({
      model: 'gpt-oss-120b',
      webSearchEnabled: false,
    })
    expect(result.current.getPresetById(id)).toMatchObject({
      model: 'gpt-oss-120b',
      webSearchEnabled: false,
    })
  })

  it('omits unset settings from the stored preset', () => {
    const { result } = renderHook(() => usePromptLibrary())

    let id = ''
    act(() => {
      id = result.current.createUserPreset({
        name: 'Plain',
        description: '',
        systemPrompt: PROMPT,
        model: undefined,
        webSearchEnabled: undefined,
      }).id
    })

    const stored = readUserPresets().find((p) => p.id === id)
    expect(stored).toBeDefined()
    expect('model' in stored!).toBe(false)
    expect('webSearchEnabled' in stored!).toBe(false)
  })

  it('clears a setting when an edit sets it back to unset', () => {
    const { result } = renderHook(() => usePromptLibrary())

    let id = ''
    act(() => {
      id = result.current.createUserPreset({
        name: 'Proofreader',
        description: '',
        systemPrompt: PROMPT,
        model: 'gpt-oss-120b',
        webSearchEnabled: false,
      }).id
    })
    act(() => {
      result.current.updateUserPreset(id, { model: undefined })
    })

    const stored = readUserPresets().find((p) => p.id === id)
    expect('model' in stored!).toBe(false)
    expect(stored!.webSearchEnabled).toBe(false)
  })

  it('leaves settings alone when an edit does not mention them', () => {
    const { result } = renderHook(() => usePromptLibrary())

    let id = ''
    act(() => {
      id = result.current.createUserPreset({
        name: 'Proofreader',
        description: '',
        systemPrompt: PROMPT,
        model: 'gpt-oss-120b',
      }).id
    })
    act(() => {
      result.current.updateUserPreset(id, { name: 'Renamed' })
    })

    const stored = readUserPresets().find((p) => p.id === id)
    expect(stored).toMatchObject({ name: 'Renamed', model: 'gpt-oss-120b' })
  })

  it('copies settings when duplicating a user preset', () => {
    const { result } = renderHook(() => usePromptLibrary())

    let sourceId = ''
    act(() => {
      sourceId = result.current.createUserPreset({
        name: 'Proofreader',
        description: '',
        systemPrompt: PROMPT,
        model: 'gpt-oss-120b',
        webSearchEnabled: false,
      }).id
    })
    let copyId = ''
    act(() => {
      copyId = result.current.duplicatePreset(sourceId)!.id
    })

    expect(copyId).not.toBe(sourceId)
    expect(readUserPresets().find((p) => p.id === copyId)).toMatchObject({
      name: 'Proofreader (copy)',
      model: 'gpt-oss-120b',
      webSearchEnabled: false,
    })
  })
})
