/**
 * LLMs often produce code fences at column 0 inside list items,
 * but CommonMark requires list continuation content to be indented
 * to the list item's content column. This function detects
 * under-indented code fences within list items and adds the
 * necessary indentation so remark parses them as part of the list.
 */
export function indentCodeBlocksInLists(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let listContentIndent = 0
  let inList = false
  let indentDelta = 0
  let inFencedBlock = false
  let reindentingBlock = false
  let openingFenceChar = ''
  let openingFenceLength = 0
  let openingFenceIndent = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prevLineBlank = i > 0 && lines[i - 1].trim() === ''
    // If inside any fenced block, check for closing fence and pass through
    if (inFencedBlock) {
      // Closing fence: 0-3 spaces relative to the container.  We approximate
      // the container margin from the opening fence's indentation.
      const leadingSpaces = line.search(/\S/)
      const closingMatch =
        leadingSpaces >= 0 && leadingSpaces <= openingFenceIndent + 3
          ? line.match(/^ *(`{3,}|~{3,})\s*$/)
          : null
      const isClosingFence =
        closingMatch !== null &&
        closingMatch[1][0] === openingFenceChar &&
        closingMatch[1].length >= openingFenceLength
      if (isClosingFence) {
        if (reindentingBlock) {
          result.push(' '.repeat(listContentIndent) + line.trim())
        } else {
          result.push(line)
        }
        inFencedBlock = false
        reindentingBlock = false
      } else if (reindentingBlock) {
        result.push(' '.repeat(indentDelta) + line)
      } else {
        result.push(line)
      }
      continue
    }

    // Check for opening fence (must be checked before list detection to avoid
    // false list matches inside top-level code blocks)
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/)
    // Per CommonMark, backtick fence info strings must not contain backticks
    const infoString = fenceMatch
      ? line.slice(fenceMatch[1].length + fenceMatch[2].length)
      : ''
    if (fenceMatch && !(fenceMatch[2][0] === '`' && infoString.includes('`'))) {
      openingFenceChar = fenceMatch[2][0]
      openingFenceLength = fenceMatch[2].length
      openingFenceIndent = fenceMatch[1].length
      inFencedBlock = true
      if (
        inList &&
        !prevLineBlank &&
        fenceMatch[1].length < listContentIndent
      ) {
        indentDelta = listContentIndent - fenceMatch[1].length
        reindentingBlock = true
        result.push(' '.repeat(indentDelta) + line)
      } else {
        reindentingBlock = false
        result.push(line)
      }
      continue
    }

    // Detect list item start (ordered: "1. ", "2.  ", unordered: "- ", "* ")
    const listMatch = line.match(/^(\s*)(\d+[.)]\s+|[-*+]\s+)/)
    if (listMatch) {
      inList = true
      listContentIndent = listMatch[1].length + listMatch[2].length
      result.push(line)
      continue
    }

    // Track when we leave the list context
    if (inList && line.trim() !== '') {
      const firstNonSpace = line.search(/\S/)
      const isNewListItem = /^\s*(\d+[.)]\s+|[-*+]\s+)/.test(line)
      if (
        firstNonSpace >= 0 &&
        firstNonSpace < listContentIndent &&
        !isNewListItem
      ) {
        inList = false
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

const CODE_PLACEHOLDER_PREFIX = '__MARKDOWN_CODE_'

function extractFencedCodeBlocks(
  text: string,
  codeBlocks: string[],
  prefix: string,
): string {
  const lines = text.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const openMatch = lines[i].match(/^((?:\s*>)* {0,3})(`{3,}|~{3,})/)
    // Per CommonMark, backtick fence info strings must not contain backticks
    const infoStr = openMatch
      ? lines[i].slice(openMatch[1].length + openMatch[2].length)
      : ''
    if (openMatch && !(openMatch[2][0] === '`' && infoStr.includes('`'))) {
      const fenceChar = openMatch[2][0]
      const fenceLen = openMatch[2].length
      const blockLines = [lines[i]]
      i++
      while (i < lines.length) {
        blockLines.push(lines[i])
        const closeMatch = lines[i].match(/^(?:\s*>)* {0,3}(`{3,}|~{3,})\s*$/)
        if (
          closeMatch &&
          closeMatch[1][0] === fenceChar &&
          closeMatch[1].length >= fenceLen
        ) {
          i++
          break
        }
        i++
      }
      codeBlocks.push(blockLines.join('\n'))
      result.push(`${prefix}CODE_BLOCK_${codeBlocks.length - 1}__`)
    } else {
      result.push(lines[i])
      i++
    }
  }

  return result.join('\n')
}

/**
 * Preprocesses markdown content to fix common formatting issues
 * and convert HTML tags to markdown equivalents.
 * Preserves code blocks and inline code to avoid breaking examples.
 */
export function preprocessMarkdown(content: string): string {
  // Fix under-indented code blocks inside list items before any other processing
  const indented = indentCodeBlocksInLists(content)

  // Extract code blocks and inline code to protect them
  const codeBlocks: string[] = []
  const inlineCode: string[] = []
  // A delimiter absent from the input cannot alias a literal code example.
  const occupiedPrefixes = new Set(
    content.match(new RegExp(`${CODE_PLACEHOLDER_PREFIX}\\d+__`, 'g')) ?? [],
  )
  let placeholderIndex = 0
  let placeholderPrefix = `${CODE_PLACEHOLDER_PREFIX}${placeholderIndex}__`
  while (occupiedPrefixes.has(placeholderPrefix)) {
    placeholderPrefix = `${CODE_PLACEHOLDER_PREFIX}${++placeholderIndex}__`
  }

  // Protect fenced code blocks (``` and ~~~)
  // A closing fence must use the same char and be >= the opening fence length (CommonMark spec)
  let processed = extractFencedCodeBlocks(
    indented,
    codeBlocks,
    placeholderPrefix,
  )

  // Protect inline code (`...`)
  processed = processed.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match)
    return `${placeholderPrefix}INLINE_CODE_${inlineCode.length - 1}__`
  })

  // Convert <a href="url">text</a> to [text](url)
  processed = processed.replace(
    /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi,
    (_, url, text) => {
      const linkText = text.trim() || url
      return `[${linkText}](${url})`
    },
  )

  // Convert <b>text</b> and <strong>text</strong> to **text**
  processed = processed.replace(/<b>([^<]*)<\/b>/gi, '**$1**')
  processed = processed.replace(/<strong>([^<]*)<\/strong>/gi, '**$1**')

  // Restore inline code first (they might be inside code blocks)
  processed = processed.replace(
    new RegExp(`${placeholderPrefix}INLINE_CODE_(\\d+)__`, 'g'),
    (_, index) => inlineCode[parseInt(index)],
  )

  // Restore code blocks
  processed = processed.replace(
    new RegExp(`${placeholderPrefix}CODE_BLOCK_(\\d+)__`, 'g'),
    (_, index) => codeBlocks[parseInt(index)],
  )

  return processed
}
