import { ensureTimeline } from './ensure-timeline'
import type { Message, TimelineBlock } from './types'

const EDITED_CONTENT_BLOCK_ID = 'edited-content'

/**
 * Rewrite an assistant message's visible text. The timeline is the render
 * source of truth, so the edit collapses every content block into a single
 * block holding the new text at the position of the first one (thinking,
 * search, and tool blocks are kept in place). Flat `content` is updated to
 * match so request building and copy see the same text.
 */
export function replaceAssistantContent(
  message: Message,
  newContent: string,
): Message {
  // Legacy messages store thoughts/search as flat fields; synthesize their
  // timeline first so those blocks survive the edit.
  const timeline = ensureTimeline(message).timeline ?? []

  const firstContentIndex = timeline.findIndex(
    (block) => block.type === 'content',
  )
  const editedBlock: TimelineBlock = {
    type: 'content',
    id:
      firstContentIndex >= 0
        ? timeline[firstContentIndex].id
        : EDITED_CONTENT_BLOCK_ID,
    content: newContent,
  }

  const before = timeline
    .slice(0, firstContentIndex >= 0 ? firstContentIndex : timeline.length)
    .filter((block) => block.type !== 'content')
  const after =
    firstContentIndex >= 0
      ? timeline
          .slice(firstContentIndex + 1)
          .filter((block) => block.type !== 'content')
      : []
  const newTimeline = newContent
    ? [...before, editedBlock, ...after]
    : [...before, ...after]

  return {
    ...message,
    content: newContent,
    timeline: newTimeline.length > 0 ? newTimeline : undefined,
  }
}
