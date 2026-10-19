import {
  AUTO_INTELLIGENCE_LEVELS,
  AUTO_MODEL_ID,
  findSelectableModel,
  getAutoDisplayName,
  getAutoModel,
  getDefaultModelId,
  getSelectedModelLabel,
  isAutoIntelligenceLevelId,
  isAutoModelId,
  isModelNameAvailable,
  resolveModelSelection,
  type BaseModel,
} from '@/config/models'
import { describe, expect, it } from 'vitest'

const chat = (
  modelName: string,
  extra: Partial<BaseModel> = {},
): BaseModel => ({
  modelName,
  image: '',
  name: modelName.toUpperCase(),
  nameShort: modelName,
  description: '',
  type: 'chat',
  chat: true,
  ...extra,
})

const textModel = chat('text-only')
const visionModel = chat('vision', { multimodal: true, toolCalling: true })
const embedding: BaseModel = {
  ...chat('embed'),
  type: 'embedding',
  chat: undefined,
}

describe('Auto intelligence levels', () => {
  it('spans the router scale from 0 to 100 in ascending order', () => {
    const values = AUTO_INTELLIGENCE_LEVELS.map((level) => level.value)
    expect(values[0]).toBe(0)
    expect(values[values.length - 1]).toBe(100)
    expect([...values].sort((a, b) => a - b)).toEqual(values)
  })

  it('produces the collapsed picker labels', () => {
    expect(
      AUTO_INTELLIGENCE_LEVELS.map((l) => getAutoDisplayName(l.id)),
    ).toEqual([
      'Auto · Instant',
      'Auto · Low',
      'Auto · Med',
      'Auto · High',
      'Auto · Extra',
      'Auto · Max',
    ])
  })

  it('validates persisted level ids', () => {
    expect(isAutoIntelligenceLevelId('max')).toBe(true)
    expect(isAutoIntelligenceLevelId('smart')).toBe(false)
    expect(isAutoIntelligenceLevelId(null)).toBe(false)
  })
})

describe('Auto picker entry', () => {
  it('exists only when a chat model does', () => {
    expect(getAutoModel([embedding])).toBeUndefined()
    expect(getAutoModel([embedding, textModel])?.modelName).toBe(AUTO_MODEL_ID)
    expect(getDefaultModelId([embedding])).toBe('')
    expect(getDefaultModelId([textModel])).toBe(AUTO_MODEL_ID)
  })

  it('is multimodal when any candidate is', () => {
    expect(getAutoModel([textModel])?.multimodal).toBe(false)
    expect(getAutoModel([textModel, visionModel])?.multimodal).toBe(true)
  })

  it('accepts the legacy tier ids as Auto', () => {
    for (const id of ['auto', 'auto-smart', 'auto-fast']) {
      expect(isAutoModelId(id)).toBe(true)
      expect(isModelNameAvailable(id, [textModel])).toBe(true)
      expect(findSelectableModel(id, [textModel])?.isAuto).toBe(true)
    }
    expect(isAutoModelId('text-only')).toBe(false)
  })

  it('labels the collapsed trigger with the level for Auto and the name otherwise', () => {
    const models = [textModel]
    expect(getSelectedModelLabel(AUTO_MODEL_ID, models, 'max')).toBe(
      'Auto · Max',
    )
    expect(getSelectedModelLabel('auto-fast', models, 'low')).toBe('Auto · Low')
    expect(getSelectedModelLabel('text-only', models, 'max')).toBe('TEXT-ONLY')
    expect(getSelectedModelLabel('missing', models, 'max')).toBeUndefined()
  })
})

describe('resolveModelSelection for Auto', () => {
  it('returns every chat model as the candidate pool', () => {
    const { model, autoCandidates } = resolveModelSelection(AUTO_MODEL_ID, [
      embedding,
      textModel,
      visionModel,
    ])
    expect(model).toBe(textModel)
    expect(autoCandidates).toEqual([textModel, visionModel])
  })

  it('narrows to capable models only when at least one satisfies the preference', () => {
    const models = [textModel, visionModel]
    expect(
      resolveModelSelection(AUTO_MODEL_ID, models, { preferMultimodal: true })
        .autoCandidates,
    ).toEqual([visionModel])
    expect(
      resolveModelSelection(AUTO_MODEL_ID, [textModel], {
        preferMultimodal: true,
      }).autoCandidates,
    ).toEqual([textModel])
  })

  it('resolves a real model without a candidate pool', () => {
    const selection = resolveModelSelection('vision', [textModel, visionModel])
    expect(selection.model).toBe(visionModel)
    expect(selection.autoCandidates).toBeUndefined()
  })
})
