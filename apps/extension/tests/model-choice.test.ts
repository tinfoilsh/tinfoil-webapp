import type { Session } from '@tinfoil/chat-client/types'
import { expect, test } from 'vitest'
import { DEFAULT_MODEL } from '../src/config'
import { turnModel, type Catalog } from '../src/model-choice'

const SERVICE_DEFAULT = 'service-default'
const CHOSEN = 'chosen-model'
const AUTO = 'auto'

function offering(
  ...models: (Partial<Session['models'][number]> & { id: string })[]
): Catalog {
  return {
    models: models.map((model) => ({
      label: model.id,
      shortLabel: model.id,
      icon: '',
      description: '',
      badges: [],
      reasoning: { toggle: false, effort: true, defaultEnabled: true },
      deprecated: false,
      ...model,
    })) as Catalog['models'],
    auto: {
      default: 'balanced',
      levels: [
        { id: 'fast', label: 'Fast', displayLabel: 'Auto · Fast' },
        { id: 'balanced', label: 'Balanced', displayLabel: 'Auto · Balanced' },
      ],
    } as Catalog['auto'],
    defaultModel: SERVICE_DEFAULT,
  }
}

test('a turn runs on the chosen model only while the service offers it', () => {
  const all = offering(
    { id: CHOSEN },
    { id: DEFAULT_MODEL },
    { id: SERVICE_DEFAULT },
  )
  expect(turnModel(all, { model: CHOSEN })).toEqual({ model: CHOSEN })
  expect(turnModel(all, { model: null })).toEqual({ model: DEFAULT_MODEL })

  // A model the service has withdrawn or retired gives way to the
  // extension's default, and that to the service's.
  expect(turnModel(all, { model: 'withdrawn' })).toEqual({
    model: DEFAULT_MODEL,
  })
  const retired = offering(
    { id: CHOSEN, deprecated: true },
    { id: DEFAULT_MODEL, deprecated: true },
    { id: SERVICE_DEFAULT },
  )
  expect(turnModel(retired, { model: CHOSEN })).toEqual({
    model: SERVICE_DEFAULT,
  })
  expect(turnModel(null, { model: CHOSEN })).toEqual({ model: DEFAULT_MODEL })
})

test('Auto works at the chosen level while the service offers it, and at its default otherwise', () => {
  const all = offering({ id: AUTO, auto: true }, { id: DEFAULT_MODEL })
  expect(turnModel(all, { model: AUTO, autoLevel: 'fast' })).toEqual({
    model: AUTO,
    autoIntelligence: 'fast',
  })
  expect(turnModel(all, { model: AUTO, autoLevel: 'withdrawn' })).toEqual({
    model: AUTO,
    autoIntelligence: 'balanced',
  })
  expect(turnModel(all, { model: AUTO })).toEqual({
    model: AUTO,
    autoIntelligence: 'balanced',
  })
  // A level kept from when Auto was chosen is not sent with another model.
  expect(turnModel(all, { model: DEFAULT_MODEL, autoLevel: 'fast' })).toEqual({
    model: DEFAULT_MODEL,
  })
})
