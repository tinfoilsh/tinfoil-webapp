/**
 * Content preprocessor pipeline.
 *
 * Strips `<tinfoil-event>...</tinfoil-event>` markers from `delta.content`
 * and extracts web-search / URL-fetch events before the event normalizer
 * sees the text.
 */

import {
  createTinfoilEventParser,
  type TinfoilEvent,
} from '@/utils/tinfoil-events'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PreprocessedContent {
  text: string
  toolEvents: TinfoilEvent[]
}

export interface ContentPreprocessor {
  process(rawContent: string): PreprocessedContent
  flush(): { text: string }
}

export function createContentPreprocessor(): ContentPreprocessor {
  const tinfoilParser = createTinfoilEventParser()

  return {
    process(rawContent: string): PreprocessedContent {
      const { text, events } = tinfoilParser.consume(rawContent)
      return { text, toolEvents: events }
    },

    flush(): { text: string } {
      const tinfoilTail = tinfoilParser
        .flush()
        .replace(/<\/?tinfoil-event>/g, '')
      return { text: tinfoilTail }
    },
  }
}
