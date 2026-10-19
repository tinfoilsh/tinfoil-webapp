import {
  getAutoModel,
  getReasoningHistoryPolicy,
  getResolvedModelContextWindowTokens,
  type BaseModel,
} from '@/config/models'
import {
  REASONING_HISTORY_POLICIES,
  type ReasoningHistoryPolicy,
} from '@/utils/reasoning-history'
import { describe, expect, it } from 'vitest'

const model = (
  modelName: string,
  policy?: ReasoningHistoryPolicy,
  contextWindowTokens?: number,
): BaseModel => ({
  modelName,
  image: '',
  name: modelName,
  nameShort: modelName,
  description: '',
  type: 'chat',
  chat: true,
  chatConfig: {
    contextWindowTokens,
    reasoningConfig: policy ? { reasoningHistoryPolicy: policy } : undefined,
  },
})

describe('getReasoningHistoryPolicy', () => {
  it('uses the direct model policy with a safe default', () => {
    expect(getReasoningHistoryPolicy({ model: model('standard') })).toBe(
      REASONING_HISTORY_POLICIES.none,
    )
    expect(
      getReasoningHistoryPolicy({
        model: model('kimi-k3', REASONING_HISTORY_POLICIES.all),
      }),
    ).toBe(REASONING_HISTORY_POLICIES.all)
  })

  it.each([
    [
      REASONING_HISTORY_POLICIES.none,
      REASONING_HISTORY_POLICIES.toolCallOnly,
      REASONING_HISTORY_POLICIES.all,
    ],
    [
      REASONING_HISTORY_POLICIES.all,
      REASONING_HISTORY_POLICIES.none,
      REASONING_HISTORY_POLICIES.toolCallOnly,
    ],
    [
      REASONING_HISTORY_POLICIES.toolCallOnly,
      REASONING_HISTORY_POLICIES.all,
      REASONING_HISTORY_POLICIES.none,
    ],
  ])('uses the strongest Auto candidate policy: %s, %s, %s', (...policies) => {
    expect(
      getReasoningHistoryPolicy({
        model: model('standard'),
        autoCandidates: policies.map((policy, index) =>
          model(`candidate-${index}`, policy),
        ),
      }),
    ).toBe(REASONING_HISTORY_POLICIES.all)
  })

  it('falls back safely for unknown future policies', () => {
    const futureModel = model('future')
    futureModel.chatConfig = {
      reasoningConfig: { reasoningHistoryPolicy: 'future-policy' as never },
    }

    expect(getReasoningHistoryPolicy({ model: futureModel })).toBe(
      REASONING_HISTORY_POLICIES.none,
    )
  })

  it.each([
    [256000, 32000, undefined],
    [32000, undefined, 256000],
  ])('uses the smallest Auto candidate context window: %j', (...windows) => {
    const candidates = windows.map((window, index) =>
      model(`candidate-${index}`, undefined, window),
    )

    expect(
      getResolvedModelContextWindowTokens({
        model: candidates[0],
        autoCandidates: candidates,
      }),
    ).toBe(32000)
    expect(getAutoModel(candidates)?.chatConfig?.contextWindowTokens).toBe(
      32000,
    )
  })
})
