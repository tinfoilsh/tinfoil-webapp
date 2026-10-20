import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WIDGET_TYPES,
  WIDGETS_JSON,
  widgetTypes,
} from '../../scripts/generate-widget-types.mjs'

// The harness checkout beside this one, as `npm run generate:widgets` reads
// it. CI has no such checkout.
const harnessCheckout = existsSync(WIDGETS_JSON)

describe('widget argument types', () => {
  it.skipIf(!harnessCheckout)(
    "match the harness's widget declarations",
    async () => {
      const declarations = JSON.parse(readFileSync(WIDGETS_JSON, 'utf8'))
      expect(readFileSync(WIDGET_TYPES, 'utf8')).toBe(
        await widgetTypes(declarations),
      )
    },
  )
})
