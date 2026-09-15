import type { Message, TimelineBlock } from './types'

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
  const timeline = message.timeline
  if (!timeline || timeline.length === 0) {
    return {
      ...message,
      content: newContent,
      timeline: newContent
        ? [{ type: 'content', id: 'edited-content', content: newContent }]
        : undefined,
    }
  }

  const firstContentIndex = timeline.findIndex(
    (block) => block.type === 'content',
  )
  const nonContentBlocks = timeline.filter((block) => block.type !== 'content')
  const editedBlock: TimelineBlock = {
    type: 'content',
    id:
      firstContentIndex >= 0
        ? timeline[firstContentIndex].id
        : 'edited-content',
    content: newContent,
  }

  let newTimeline: TimelineBlock[]
  if (!newContent) {
    newTimeline = nonContentBlocks
  } else if (firstContentIndex < 0) {
    newTimeline = [...nonContentBlocks, editedBlock]
  } else {
    const before = timeline
      .slice(0, firstContentIndex)
      .filter((block) => block.type !== 'content')
    const after = timeline
      .slice(firstContentIndex + 1)
      .filter((block) => block.type !== 'content')
    newTimeline = [...before, editedBlock, ...after]
  }

  return {
    ...message,
    content: newContent,
    timeline: newTimeline.length > 0 ? newTimeline : undefined,
  }
}
