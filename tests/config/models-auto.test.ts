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
it('never offers the free chat models that serve free-tier keys', () => {
  const free = {
    id: 'free-model',
    name: 'Free model',
    paid: false,
    multimodal: false,
    reasoning: null,
  }
  const paid = { ...free, id: 'paid-model', name: 'Paid model', paid: true }
  expect(
    displayModels({
      ...testSession,
      models: [...testSession.models, free, paid],
    }).map((m) => m.modelName),
  ).toEqual(['auto', 'test-model', 'paid-model'])
})
