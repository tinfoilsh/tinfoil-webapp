import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WIDGET_TYPES,
  WIDGETS_JSON,
  widgetTypes,
} from '../../scripts/generate-widget-types.mjs'

// The harness's widget declarations: the copy CI downloads from the
// harness's main branch, or the harness checkout beside this one, as
// `npm run generate:widgets` reads it.
const downloaded = process.env.HARNESS_WIDGETS_JSON
const declarationsFile = downloaded || WIDGETS_JSON

describe('widget argument types', () => {
  it.skipIf(!downloaded && !existsSync(WIDGETS_JSON))(
    "match the harness's widget declarations",
    async () => {
      const declarations = JSON.parse(readFileSync(declarationsFile, 'utf8'))
      expect(readFileSync(WIDGET_TYPES, 'utf8')).toBe(
        await widgetTypes(declarations),
      )
    },
  )
})
