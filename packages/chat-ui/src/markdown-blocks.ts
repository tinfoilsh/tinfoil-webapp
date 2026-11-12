import type { Nodes, Root, RootContent } from 'mdast'
import remarkParse from 'remark-parse'
import { unified, type PluggableList } from 'unified'

// A part of a markdown text that renders the same alone as within the text.
export interface MarkdownBlock {
  // Where the block starts in the text, which names it.
  start: number
  text: string
}

interface Split {
  text: string
  plugins: PluggableList
  // The finished blocks, then the open one, which the text goes on in.
  blocks: MarkdownBlock[]
  // How much of the text decides the finished blocks: them and the first
  // line of the open block. A text that begins the same keeps them.
  decided: number
  // The text has definitions, which apply across blocks, so it is a single
  // block, as it stays while it grows.
  whole: boolean
}

// Elements that hold no content, so they need no closing tag.
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
// Marks raw HTML whose elements cannot be told to close, as a stray closing
// tag or a declaration; no block ends after it.
const UNBALANCED = '!'
// A blank line closes the block before it, unless the next line continues
// a list item: one indented, or another item.
const BLANK_LINE = /\n[ \t]*\n/
const CONTINUATION_START = /[\s\-+*\d]/
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const HTML_TAG = /<(\/?)([A-Za-z][\w-]*)[^>]*>/g

const parsers = new WeakMap<PluggableList, ReturnType<typeof parserOf>>()

const parserOf = (plugins: PluggableList) =>
  unified().use(remarkParse).use(plugins).freeze()

// Parses as the message renders, with the same plugins.
function parse(text: string, plugins: PluggableList): Root {
  let parser = parsers.get(plugins)
  if (!parser) {
    parser = parserOf(plugins)
    parsers.set(plugins, parser)
  }
  return parser.parse(text)
}

function some(node: Nodes, test: (node: Nodes) => boolean): boolean {
  return (
    test(node) ||
    ('children' in node && node.children.some((child) => some(child, test)))
  )
}

// The elements raw HTML leaves open after a node, from those open before
// it. Raw HTML renders as one document, so a block ends only where none is.
function openElements(open: string[], node: RootContent): string[] {
  const html: string[] = []
  some(node, (child) => {
    if (child.type === 'html') html.push(child.value)
    return false
  })
  if (!html.length) return open
  const stack = [...open]
  for (const value of html) {
    const markup = value.replace(HTML_COMMENT, '')
    if (/<[!?]/.test(markup)) return [UNBALANCED]
    for (const [, closing, tag] of markup.matchAll(HTML_TAG)) {
      const name = tag.toLowerCase()
      if (VOID_ELEMENTS.has(name)) continue
      if (!closing) stack.push(name)
      else if (stack.at(-1) === name) stack.pop()
      else return [UNBALANCED]
    }
  }
  return stack
}

const lineStart = (text: string, offset: number) =>
  text.lastIndexOf('\n', offset - 1) + 1

// Splits a markdown text into top-level blocks as it grows, so each update
// parses only its open block again; the finished ones keep their text. A
// block ends only where the text that follows cannot change it: where the
// next block began after a blank line or its first line is complete, and no
// raw HTML element is open. A text with link or footnote definitions, which
// apply across blocks, is a single block.
export class MarkdownBlocks {
  private split: Split | null = null

  // The blocks of the text. A text that never streamed is a single block.
  update(
    text: string,
    plugins: PluggableList,
    streaming: boolean,
  ): MarkdownBlock[] {
    const previous = this.split
    const whole = [{ start: 0, text }]
    if (!previous && !streaming) return whole
    const kept =
      previous?.plugins === plugins &&
      text.startsWith(previous.text.slice(0, previous.decided))
        ? previous
        : null
    // A text with definitions stays whole as it grows, without parsing.
    const open = kept?.whole ? 0 : (kept?.blocks.at(-1)?.start ?? 0)
    const tree = kept?.whole ? null : parse(text.slice(open), plugins)
    if (
      !tree ||
      some(
        tree,
        (node) =>
          node.type === 'definition' || node.type === 'footnoteDefinition',
      )
    ) {
      this.split = {
        text,
        plugins,
        blocks: whole,
        decided: text.length,
        whole: true,
      }
      return whole
    }
    const blocks = kept ? kept.blocks.slice(0, -1) : []
    const nodes = tree.children
    let from = open
    let decided = kept?.decided ?? 0
    let elements: string[] = []
    for (let index = 0; index < nodes.length - 1; index++) {
      elements = openElements(elements, nodes[index])
      if (elements.length) continue
      const end = nodes[index].position?.end.offset
      const offset = nodes[index + 1].position?.start.offset
      if (end === undefined || offset === undefined) break
      const start = lineStart(text, open + offset)
      const lineEnd = text.indexOf('\n', start)
      // The next block's first line, while it streams, may still turn out
      // to continue this block, unless a blank line closed it.
      const closed =
        BLANK_LINE.test(text.slice(open + end, start)) &&
        !CONTINUATION_START.test(text[start])
      if (lineEnd < 0 && !closed) break
      blocks.push({ start: from, text: text.slice(from, start) })
      from = start
      decided = lineEnd < 0 ? start + 1 : lineEnd + 1
    }
    blocks.push({ start: from, text: text.slice(from) })
    this.split = { text, plugins, blocks, decided, whole: false }
    return blocks
  }
}
