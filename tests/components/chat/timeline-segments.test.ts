import { segmentTimeline } from '@/components/chat/renderers/default/timeline-segments'
import type { TimelineBlock } from '@/components/chat/types'
import { describe, expect, it } from 'vitest'

const thinking = (id: string, content = 'thought'): TimelineBlock => ({
  type: 'thinking',
  id,
  content,
  isThinking: false,
  duration: 1,
})
const search = (id: string): TimelineBlock => ({
  type: 'web_search',
  id,
  state: { query: id, status: 'completed', sources: [] },
})
const content = (id: string, text: string): TimelineBlock => ({
  type: 'content',
  id,
  content: text,
})

describe('segmentTimeline', () => {
  it('collapses consecutive trace blocks into one work segment', () => {
    const timeline = [
      thinking('t0'),
      search('s1'),
      search('s2'),
      content('c3', 'Answer'),
    ]
    expect(segmentTimeline(timeline)).toEqual([
      {
        kind: 'work',
        key: 'work-t0',
        blocks: [timeline[0], timeline[1], timeline[2]],
      },
      { kind: 'block', block: timeline[3], blockIndex: 3 },
    ])
  })

  it('does not split a run on whitespace-only content between tool calls', () => {
    const timeline = [search('s0'), content('c1', '\n\n'), search('s2')]
    const segments = segmentTimeline(timeline)
    expect(segments).toEqual([
      { kind: 'work', key: 'work-s0', blocks: [timeline[0], timeline[2]] },
    ])
  })

  it('leaves a lone trace block as a plain block with its timeline index', () => {
    const timeline = [content('c0', 'Intro'), search('s1'), content('c2', 'A')]
    expect(segmentTimeline(timeline)).toEqual([
      { kind: 'block', block: timeline[0], blockIndex: 0 },
      { kind: 'block', block: timeline[1], blockIndex: 1 },
      { kind: 'block', block: timeline[2], blockIndex: 2 },
    ])
  })

  it('ends a run at answer text and GenUI widgets', () => {
    const widget: TimelineBlock = {
      type: 'tool_call',
      id: 'w2',
      toolCallId: 'call-1',
      name: 'chart',
      arguments: '{}',
    }
    const timeline = [
      thinking('t0'),
      search('s1'),
      widget,
      search('s3'),
      thinking('t4'),
      content('c5', 'Done'),
    ]
    expect(segmentTimeline(timeline).map((s) => s.kind)).toEqual([
      'work',
      'block',
      'work',
      'block',
    ])
  })

  it('skips closed empty thinking blocks without breaking the run', () => {
    const timeline = [search('s0'), thinking('t1', '   '), search('s2')]
    expect(segmentTimeline(timeline)).toEqual([
      { kind: 'work', key: 'work-s0', blocks: [timeline[0], timeline[2]] },
    ])
  })

  it('keeps an empty but still-open thinking block visible', () => {
    const open: TimelineBlock = {
      type: 'thinking',
      id: 't1',
      content: '',
      isThinking: true,
    }
    const timeline = [search('s0'), open]
    expect(segmentTimeline(timeline)).toEqual([
      { kind: 'work', key: 'work-s0', blocks: [timeline[0], open] },
    ])
  })
})
