import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { SPEECH } from './constants'
import { SpeechError } from './errors'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

export type SpeechTextFormat = 'markdown' | 'plain'

function readableText(node: Nodes): string {
  switch (node.type) {
    case 'code':
    case 'definition':
    case 'footnoteDefinition':
    case 'footnoteReference':
    case 'image':
    case 'imageReference':
    case 'thematicBreak':
      return ''
    case 'text':
    case 'inlineCode':
    case 'math':
    case 'inlineMath':
      return node.value
    case 'html':
      return /^<br\s*\/?>$/i.test(node.value.trim()) ? '\n' : ''
    case 'break':
      return '\n'
    case 'link':
    case 'linkReference': {
      const label = node.children.map(readableText).join('')
      // Citation badges and autolinks do not add useful narration.
      return (node.type === 'link' && label === node.url) ||
        /^\[?\d+\]?$/.test(label)
        ? ''
        : label
    }
    default: {
      if (!('children' in node)) return ''
      const separator = [
        'root',
        'blockquote',
        'list',
        'listItem',
        'table',
        'tableRow',
      ].includes(node.type)
        ? '\n'
        : ''
      return node.children.map(readableText).join(separator)
    }
  }
}

export function prepareSpeechText(
  markdown: string,
  format: SpeechTextFormat = 'markdown',
): string {
  if (markdown.length > SPEECH.MAX_TEXT_CHARACTERS) {
    throw new SpeechError('too-long')
  }
  if (format === 'plain') return markdown.trim()
  return readableText(parser.parse(markdown))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim()
}

export function splitSpeechText(text: string): string[] {
  const sentences =
    typeof Intl.Segmenter === 'function'
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(
            text,
          ),
          ({ segment }) => segment,
        )
      : (text.match(/[\s\S]+?(?:[.!?。！？](?=\s|$)|$)/gu) ?? [])
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }

  for (const sentence of sentences) {
    // Code points keep surrogate pairs intact when an unbroken sentence is oversized.
    const points = Array.from(sentence.trim())
    while (points.length > SPEECH.MAX_CHUNK_CHARACTERS) {
      flush()
      let end: number = SPEECH.MAX_CHUNK_CHARACTERS
      for (let i = end; i > SPEECH.TARGET_CHUNK_CHARACTERS; i--) {
        if (/\s/u.test(points[i])) {
          end = i
          break
        }
      }
      chunks.push(points.splice(0, end).join('').trim())
    }
    const remainder = points.join('').trim()
    if (!remainder) continue
    if (
      Array.from(current).length + points.length + 1 >
      SPEECH.MAX_CHUNK_CHARACTERS
    )
      flush()
    current = current ? `${current} ${remainder}` : remainder
    if (Array.from(current).length >= SPEECH.TARGET_CHUNK_CHARACTERS) flush()
  }
  flush()
  return chunks
}
