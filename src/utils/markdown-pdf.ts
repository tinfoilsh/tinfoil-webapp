/**
 * Markdown as a PDF, made on this device with pdfmake: selectable text laid
 * out on pages, in a light theme whatever the app's. Nothing about the
 * document is sent anywhere; the only requests fetch the fonts it uses from
 * this origin, where `scripts/copy-vendor.mjs` puts the files listed in
 * `pdf-fonts.json`.
 *
 * DejaVu Sans covers Latin, Greek and Cyrillic text with the punctuation,
 * arrows, math and box drawing models write; emoji are set in Noto Emoji's
 * outlines, as PDF fonts cannot draw color emoji. Letters of scripts neither
 * covers, such as Chinese or Japanese, show as empty boxes.
 */
import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { preprocessMarkdown } from '@/utils/markdown-preprocessing'
import { sanitizeUrl } from '@braintree/sanitize-url'
import type {
  Blockquote,
  Code,
  FootnoteDefinition,
  Heading,
  List,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast'
import type {
  ContentCanvas,
  ContentColumns,
  ContentOrderedList,
  ContentStack,
  ContentTable,
  ContentText,
  ContentUnorderedList,
  CustomTableLayout,
  Margins,
  OrderedListElementProperties,
  Size,
  TableCell,
  TDocumentDefinitions,
  TFontDictionary,
  UnorderedListElementProperties,
} from 'pdfmake/interfaces'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const FONT_DIRECTORY = '/vendor/fonts/'

type FontFamily = 'Body' | 'Mono' | 'Emoji'
type FontStyle = 'normal' | 'bold' | 'italics' | 'bolditalics'

const FONT_STYLES: FontStyle[] = ['normal', 'bold', 'italics', 'bolditalics']

const FONT_FILES: Record<FontFamily, Record<FontStyle, string>> = {
  Body: {
    normal: 'DejaVuSans.ttf',
    bold: 'DejaVuSans-Bold.ttf',
    italics: 'DejaVuSans-Oblique.ttf',
    bolditalics: 'DejaVuSans-BoldOblique.ttf',
  },
  Mono: {
    normal: 'DejaVuSansMono.ttf',
    bold: 'DejaVuSansMono-Bold.ttf',
    italics: 'DejaVuSansMono-Oblique.ttf',
    bolditalics: 'DejaVuSansMono-BoldOblique.ttf',
  },
  Emoji: {
    normal: 'NotoEmoji-Regular.ttf',
    bold: 'NotoEmoji-Bold.ttf',
    italics: 'NotoEmoji-Regular.ttf',
    bolditalics: 'NotoEmoji-Bold.ttf',
  },
}

// A4, in points, with the page number set in the bottom margin.
const PAGE_SIZE = 'A4'
const PAGE_WIDTH = 595.28
const PAGE_MARGINS: [number, number, number, number] = [56, 56, 56, 56]
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGINS[0] - PAGE_MARGINS[2]
const FOOTER_OFFSET = 24
const PAGE_NUMBER_STYLE = 'pageNumber'

const FONT_SIZE = 10.5
const LINE_HEIGHT = 1.3
const TABLE_FONT_SIZE = 9.5
const CODE_FONT_SIZE = 9
const CODE_LINE_HEIGHT = 1.2
const FOOTER_FONT_SIZE = 8
const HEADING_FONT_SIZES = [20, 16, 13.5, 12, 11, 10.5]

const BLOCK_GAP = 8
const HEADING_GAP_ABOVE = 10
const HEADING_GAP_BELOW = 4
const LIST_ITEM_GAP = 3
const LIST_INDENT = 14
const RULE_GAP = 6
const RULE_WIDTH = 0.75
const BORDER_WIDTH = 0.5
const QUOTE_BAR_WIDTH = 3
const QUOTE_PADDING = 10
const CELL_PADDING_X = 6
const CELL_PADDING_Y = 4
const CODE_PADDING = 8
const MARKER_GAP = 5

const COLORS = {
  text: '#111827',
  muted: '#4b5563',
  link: '#1d4ed8',
  border: '#d1d5db',
  quoteBar: '#9ca3af',
  tableHeader: '#f3f4f6',
  codeBackground: '#f3f4f6',
}

const CHECKED_BOX = '☑'
const UNCHECKED_BOX = '☐'
const TAB_AS_SPACES = '    '
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const INLINE_LINE_BREAK = /^<br\s*\/?>$/i

// An emoji as it shows in color: a flag, a keycap, or a pictograph drawn as
// emoji by default or by its variation selector, with any modifiers, tags,
// and joined pictographs.
const EMOJI = new RegExp(
  [
    '\\p{Regional_Indicator}{2}',
    '[#*0-9]\\uFE0F?\\u20E3',
    '(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)' +
      '(?:\\p{Emoji_Modifier}|\\uFE0F|[\\u{E0020}-\\u{E007F}])*' +
      '(?:\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)*)*',
  ].join('|'),
  'gu',
)

const TABLE_LAYOUT: CustomTableLayout = {
  hLineWidth: () => BORDER_WIDTH,
  vLineWidth: () => BORDER_WIDTH,
  hLineColor: () => COLORS.border,
  vLineColor: () => COLORS.border,
  paddingLeft: () => CELL_PADDING_X,
  paddingRight: () => CELL_PADDING_X,
  paddingTop: () => CELL_PADDING_Y,
  paddingBottom: () => CELL_PADDING_Y,
}

const CODE_LAYOUT: CustomTableLayout = {
  hLineWidth: () => BORDER_WIDTH,
  vLineWidth: () => BORDER_WIDTH,
  hLineColor: () => COLORS.border,
  vLineColor: () => COLORS.border,
  fillColor: () => COLORS.codeBackground,
  paddingLeft: () => CODE_PADDING,
  paddingRight: () => CODE_PADDING,
  paddingTop: () => CODE_PADDING,
  paddingBottom: () => CODE_PADDING,
}

const QUOTE_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: (index) => (index === 0 ? QUOTE_BAR_WIDTH : 0),
  vLineColor: () => COLORS.quoteBar,
  paddingLeft: () => QUOTE_PADDING,
  paddingRight: () => 0,
  paddingTop: () => 0,
  paddingBottom: () => 0,
}

interface Marks {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
  sup?: boolean
  link?: string
}

interface BlockContext {
  // The width blocks are laid out in, in points.
  width: number
  // In a tight list, paragraphs keep no space below them.
  tight: boolean
}

type Block =
  | ContentText
  | ContentTable
  | ContentCanvas
  | ContentStack
  | ContentColumns
  | ContentUnorderedList
  | ContentOrderedList

type ListElement = Block &
  UnorderedListElementProperties &
  OrderedListElementProperties

function fontStyle(bold: boolean, italics: boolean): FontStyle {
  if (bold && italics) return 'bolditalics'
  if (bold) return 'bold'
  return italics ? 'italics' : 'normal'
}

// Splits text into the parts drawn in the emoji font and the rest.
function emojiParts(text: string): { text: string; emoji: boolean }[] {
  const parts: { text: string; emoji: boolean }[] = []
  let end = 0
  for (const match of text.matchAll(EMOJI)) {
    if (match.index > end)
      parts.push({ text: text.slice(end, match.index), emoji: false })
    parts.push({ text: match[0], emoji: true })
    end = match.index + match[0].length
  }
  if (end < text.length || parts.length === 0)
    parts.push({ text: text.slice(end), emoji: false })
  return parts
}

// Only links a reader can follow from a file: web pages and mail.
function linkTarget(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const target = new URL(sanitizeUrl(url))
    return LINK_PROTOCOLS.has(target.protocol) ? target.href : undefined
  } catch {
    return undefined
  }
}

function htmlText(html: string): string {
  return (
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  ).trim()
}

function withoutGapBelow<T extends Block>(blocks: T[]): T[] {
  const last = blocks.at(-1)
  const margin = last?.margin
  if (!last || !Array.isArray(margin) || margin.length !== 4) return blocks
  const [left, top, right] = margin
  return [...blocks.slice(0, -1), { ...last, margin: [left, top, right, 0] }]
}

function definitionsOf(root: Root): Map<string, string> {
  const definitions = new Map<string, string>()
  const visit = (node: Nodes) => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
    if ('children' in node) node.children.forEach(visit)
  }
  visit(root)
  return definitions
}

class PdfWriter {
  // The font files the document is set in. The page numbers are in the
  // regular body font.
  readonly fonts = new Map<FontFamily, Set<FontStyle>>([
    ['Body', new Set(['normal'])],
  ])
  readonly footnotes: FootnoteDefinition[] = []

  constructor(private readonly definitions: Map<string, string>) {}

  private use(family: FontFamily, style: FontStyle) {
    const styles = this.fonts.get(family) ?? new Set<FontStyle>()
    styles.add(style)
    this.fonts.set(family, styles)
  }

  runs(text: string, marks: Marks): ContentText[] {
    const bold = !!marks.bold
    const italics = !!marks.italics
    return emojiParts(text).map((part) => {
      const font: FontFamily = part.emoji
        ? 'Emoji'
        : marks.code
          ? 'Mono'
          : 'Body'
      this.use(font, fontStyle(bold, italics))
      const run: ContentText = { text: part.text, font, bold, italics }
      if (marks.code) run.background = COLORS.codeBackground
      if (marks.sup) run.sup = true
      if (marks.link) {
        run.link = marks.link
        run.color = COLORS.link
      }
      if (marks.link || marks.strike)
        run.decoration = [
          ...(marks.link ? ['underline' as const] : []),
          ...(marks.strike ? ['lineThrough' as const] : []),
        ]
      return run
    })
  }

  inline(nodes: PhrasingContent[], marks: Marks): ContentText[] {
    return nodes.flatMap((node) => this.phrasing(node, marks))
  }

  private phrasing(node: PhrasingContent, marks: Marks): ContentText[] {
    switch (node.type) {
      case 'text':
        return this.runs(node.value, marks)
      case 'strong':
        return this.inline(node.children, { ...marks, bold: true })
      case 'emphasis':
        return this.inline(node.children, { ...marks, italics: true })
      case 'delete':
        return this.inline(node.children, { ...marks, strike: true })
      case 'inlineCode':
        return this.runs(node.value, { ...marks, code: true })
      case 'break':
        return this.runs('\n', marks)
      case 'link':
        return this.inline(node.children, {
          ...marks,
          link: linkTarget(node.url),
        })
      case 'linkReference':
        return this.inline(node.children, {
          ...marks,
          link: linkTarget(this.definitions.get(node.identifier)),
        })
      // Images are not fetched: the document names them instead.
      case 'image':
        return this.runs(node.alt || node.url, {
          ...marks,
          italics: true,
          link: linkTarget(node.url),
        })
      case 'imageReference':
        return node.alt ? this.runs(node.alt, { ...marks, italics: true }) : []
      case 'footnoteReference':
        return this.runs(node.label ?? node.identifier, { ...marks, sup: true })
      // Formulas keep their TeX source, as code.
      case 'inlineMath':
        return this.runs(node.value, { ...marks, code: true })
      case 'html':
        return INLINE_LINE_BREAK.test(node.value.trim())
          ? this.runs('\n', marks)
          : []
      default:
        return []
    }
  }

  blocks(nodes: RootContent[], context: BlockContext): Block[] {
    return nodes.flatMap((node) => this.block(node, context))
  }

  private block(node: RootContent, context: BlockContext): Block[] {
    const gap: Margins = [0, 0, 0, context.tight ? 0 : BLOCK_GAP]
    switch (node.type) {
      case 'heading':
        return [this.heading(node)]
      case 'paragraph':
        return [{ text: this.inline(node.children, {}), margin: gap }]
      case 'thematicBreak':
        return [this.rule(context.width)]
      case 'blockquote':
        return [this.quote(node, context)]
      case 'list':
        return [{ ...this.list(node, context), margin: gap }]
      case 'code':
        return [this.code(node)]
      case 'math':
        return [
          {
            text: this.runs(node.value, { code: true }),
            alignment: 'center',
            margin: gap,
          },
        ]
      case 'table':
        return [this.table(node)]
      case 'html': {
        const text = htmlText(node.value)
        return text ? [{ text: this.runs(text, {}), margin: gap }] : []
      }
      case 'footnoteDefinition':
        this.footnotes.push(node)
        return []
      default:
        return []
    }
  }

  private heading(node: Heading): Block {
    return {
      text: this.inline(node.children, { bold: true }),
      fontSize: HEADING_FONT_SIZES[node.depth - 1],
      headlineLevel: node.depth,
      outline: true,
      margin: [0, HEADING_GAP_ABOVE, 0, HEADING_GAP_BELOW],
    }
  }

  private rule(width: number): Block {
    return {
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: width,
          y2: 0,
          lineWidth: RULE_WIDTH,
          lineColor: COLORS.border,
        },
      ],
      margin: [0, RULE_GAP, 0, RULE_GAP],
    }
  }

  private quote(node: Blockquote, context: BlockContext): Block {
    const width = context.width - QUOTE_BAR_WIDTH - QUOTE_PADDING
    return {
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: withoutGapBelow(
                this.blocks(node.children, { width, tight: false }),
              ),
              color: COLORS.muted,
            },
          ],
        ],
      },
      layout: QUOTE_LAYOUT,
      margin: [0, 0, 0, BLOCK_GAP],
    }
  }

  private list(node: List, context: BlockContext): Block {
    const width = context.width - LIST_INDENT
    const items = withoutGapBelow(
      node.children.map((item) =>
        this.listItem(item, { width, tight: !node.spread && !item.spread }),
      ),
    )
    return node.ordered ? { ol: items, start: node.start ?? 1 } : { ul: items }
  }

  private listItem(item: ListItem, context: BlockContext): ListElement {
    const content = withoutGapBelow(this.blocks(item.children, context))
    const margin: Margins = [0, 0, 0, LIST_ITEM_GAP]
    if (typeof item.checked !== 'boolean') return { stack: content, margin }
    return {
      columns: [
        {
          width: 'auto',
          text: this.runs(item.checked ? CHECKED_BOX : UNCHECKED_BOX, {}),
        },
        { width: '*', stack: content },
      ],
      columnGap: MARKER_GAP,
      listType: 'none',
      margin,
    }
  }

  private code(node: Code): Block {
    return {
      table: {
        widths: ['*'],
        body: [
          [
            {
              text: this.runs(node.value.replace(/\t/g, TAB_AS_SPACES), {
                code: true,
              }),
              fontSize: CODE_FONT_SIZE,
              lineHeight: CODE_LINE_HEIGHT,
              preserveLeadingSpaces: true,
            },
          ],
        ],
      },
      layout: CODE_LAYOUT,
      margin: [0, 0, 0, BLOCK_GAP],
    }
  }

  private table(node: Table): Block {
    const [header, ...body] = node.children
    const columns = header?.children.length ?? 0
    const lengths = new Array<number>(columns).fill(0)
    const rows: TableCell[][] = [header, ...body].map((row, rowIndex) => {
      const cells = Array.from({ length: columns }, (_, column) => {
        const runs = this.inline(row?.children[column]?.children ?? [], {
          bold: rowIndex === 0,
        })
        lengths[column] += runs.reduce(
          (length, run) => length + String(run.text).length,
          0,
        )
        return {
          // An empty cell keeps a line's height, as a row to fill in.
          text: runs.length > 0 ? runs : '',
          alignment: node.align?.[column] ?? undefined,
          fillColor: rowIndex === 0 ? COLORS.tableHeader : undefined,
        }
      })
      return cells
    })
    // The column with the most text takes the width the others leave.
    const widest = lengths.indexOf(Math.max(...lengths))
    const widths: Size[] = lengths.map((_, column) =>
      column === widest ? '*' : 'auto',
    )
    return {
      table: {
        headerRows: 1,
        widths,
        body: rows,
      },
      layout: TABLE_LAYOUT,
      fontSize: TABLE_FONT_SIZE,
      margin: [0, 0, 0, BLOCK_GAP],
    }
  }

  footnoteBlocks(): Block[] {
    if (this.footnotes.length === 0) return []
    return [
      this.rule(CONTENT_WIDTH),
      ...this.footnotes.map((footnote): Block => ({
        columns: [
          {
            width: 'auto',
            text: this.runs(footnote.label ?? footnote.identifier, {
              sup: true,
            }),
          },
          {
            width: '*',
            stack: withoutGapBelow(
              this.blocks(footnote.children, {
                width: CONTENT_WIDTH,
                tight: false,
              }),
            ),
          },
        ],
        columnGap: MARKER_GAP,
        margin: [0, 0, 0, LIST_ITEM_GAP],
      })),
    ]
  }
}

interface MarkdownPdf {
  document: TDocumentDefinitions
  // The font files of each family and style the document is set in.
  fonts: TFontDictionary
}

function markdownPdf(markdown: string, title?: string): MarkdownPdf {
  // Parsed with the plugins a chat reply uses.
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkGfm)
    .use(remarkBreaks)
  const text = sanitizeUnsupportedMathBlocks(
    processLatexTags(preprocessMarkdown(markdown)),
  )
  const root = processor.runSync(processor.parse(text)) as Root
  const writer = new PdfWriter(definitionsOf(root))
  const content = [
    ...writer.blocks(root.children, { width: CONTENT_WIDTH, tight: false }),
    ...writer.footnoteBlocks(),
  ]

  const fonts: TFontDictionary = {}
  for (const [family, styles] of writer.fonts) {
    const files = FONT_FILES[family]
    // A style the document does not use names a file it already fetches.
    const [fallback] = styles
    fonts[family] = Object.fromEntries(
      FONT_STYLES.map((style) => [
        style,
        files[styles.has(style) ? style : fallback],
      ]),
    )
  }

  return {
    document: {
      info: { title },
      pageSize: PAGE_SIZE,
      pageMargins: PAGE_MARGINS,
      defaultStyle: {
        font: 'Body',
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        color: COLORS.text,
      },
      content,
      styles: {
        [PAGE_NUMBER_STYLE]: {
          alignment: 'right',
          fontSize: FOOTER_FONT_SIZE,
          color: COLORS.muted,
        },
      },
      footer: (currentPage, pageCount) => ({
        text: `${currentPage} / ${pageCount}`,
        style: PAGE_NUMBER_STYLE,
        margin: [PAGE_MARGINS[0], FOOTER_OFFSET, PAGE_MARGINS[2], 0],
      }),
      // A heading starts the next page rather than end this one, unless
      // nothing follows it. Page numbers do not count as what follows.
      pageBreakBefore: (node, nodes) =>
        node.headlineLevel !== undefined &&
        nodes
          .getFollowingNodesOnPage()
          .every((next) => next.style === PAGE_NUMBER_STYLE) &&
        nodes
          .getNodesOnNextPage()
          .some((next) => next.style !== PAGE_NUMBER_STYLE),
    },
    fonts,
  }
}

export async function createMarkdownPdf(
  markdown: string,
  title?: string,
): Promise<Blob> {
  const { document, fonts } = markdownPdf(markdown, title)
  const { default: pdfMake } = await import('pdfmake/build/pdfmake')
  const fontDirectory = new URL(FONT_DIRECTORY, window.location.origin).href
  pdfMake.setUrlAccessPolicy((url) => url.startsWith(fontDirectory))
  pdfMake.setFonts(
    Object.fromEntries(
      Object.entries(fonts).map(([family, files]) => [
        family,
        Object.fromEntries(
          Object.entries(files).map(([style, file]) => [
            style,
            new URL(String(file), fontDirectory).href,
          ]),
        ),
      ]),
    ),
  )
  return pdfMake.createPdf(document).getBlob()
}
