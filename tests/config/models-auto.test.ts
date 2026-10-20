import { displayModels, getAutoIntelligenceLevels } from '@/config/models'
import { expect, it } from 'vitest'
import { testSession } from '../harness-fixture'
it('uses the session to display model capabilities and Auto', () => {
  expect(
    displayModels({ ...testSession, auto: null }).map((m) => m.modelName),
  ).toEqual(['test-model'])
  expect(displayModels(testSession)[0]).toMatchObject({
    modelName: 'auto',
    isAuto: true,
    multimodal: false,
  })
  expect(getAutoIntelligenceLevels().map((level) => level.id)).toEqual(
    testSession.auto!.levels.map((level) => level.id),
  )
})
it('offers every model the session lists, as the harness chose them', () => {
  const free = {
    id: 'free-model',
    name: 'Free model',
    paid: false,
    multimodal: false,
    reasoning: null,
  }
  expect(
    displayModels({
      ...testSession,
      models: [...testSession.models, free],
    }).map((m) => m.modelName),
  ).toEqual(['auto', 'test-model', 'free-model'])
})
