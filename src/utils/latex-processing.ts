/**
 * LaTeX processing utilities for chat messages
 */

// Regex to match code blocks that should be preserved without processing
const CODE_BLOCK_SPLITTER = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

// Process LaTeX content for proper rendering
// Convert \[...\] to $$ blocks and \(...\) outside of those blocks to inline $$ delimiters
export function processLatexTags(text: string): string {
  const parts = text.split(CODE_BLOCK_SPLITTER)

  return parts
    .map((part) => {
      const isCodeBlock =
        part.startsWith('```') ||
        part.startsWith('~~~') ||
        (part.startsWith('`') && part.endsWith('`'))
      if (isCodeBlock) return part

      const withDelimiters = transformMathDelimiters(part)
      return convertSingleDollarLatex(withDelimiters)
    })
    .join('')
}

function transformMathDelimiters(content: string): string {
  let result = ''
  let index = 0
  let lastIndex = 0

  while (index < content.length) {
    const isDisplayOpen =
      content[index] === '\\' &&
      content[index + 1] === '[' &&
      !isEscapedDelimiter(content, index)

    if (!isDisplayOpen) {
      index += 1
      continue
    }

    const closeIndex = findMatchingDisplayClose(content, index + 2)

    if (closeIndex === -1) {
      index += 2
      continue
    }

    const before = content.slice(lastIndex, index)
    if (before) {
      result += convertInlineMath(before)
    }

    const inner = content.slice(index + 2, closeIndex).trim()
    result += `\n\n$$\n${inner}\n$$\n\n`

    index = closeIndex + 2
    lastIndex = index
  }

  const remaining = content.slice(lastIndex)
  if (remaining) {
    result += convertInlineMath(remaining)
  }

  return result
}

function findMatchingDisplayClose(segment: string, startIndex: number): number {
  let index = startIndex

  while (index < segment.length) {
    if (
      segment[index] === '\\' &&
      segment[index + 1] === ']' &&
      !isEscapedDelimiter(segment, index)
    ) {
      return index
    }

    index += 1
  }

  return -1
}

function convertInlineMath(segment: string): string {
  let output = ''
  let index = 0

  while (index < segment.length) {
    const isPotentialOpen =
      segment[index] === '\\' &&
      segment[index + 1] === '(' &&
      !isEscapedDelimiter(segment, index)

    if (!isPotentialOpen) {
      output += segment[index]
      index += 1
      continue
    }

    const start = index + 2
    const closeIndex = findMatchingInlineClose(segment, start)

    if (closeIndex === -1) {
      output += segment[index]
      index += 1
      continue
    }

    const inner = segment.slice(start, closeIndex)
    output += `$$${inner}$$`
    index = closeIndex + 2
  }

  return output
}

function findMatchingInlineClose(segment: string, startIndex: number): number {
  let depth = 0
  let index = startIndex

  while (index < segment.length) {
    const isBackslash = segment[index] === '\\'
    const nextChar = isBackslash ? segment[index + 1] : undefined

    if (
      isBackslash &&
      nextChar === '(' &&
      !isEscapedDelimiter(segment, index)
    ) {
      depth += 1
      index += 2
      continue
    }

    if (
      isBackslash &&
      nextChar === ')' &&
      !isEscapedDelimiter(segment, index)
    ) {
      if (depth === 0) {
        return index
      }

      depth -= 1
      index += 2
      continue
    }

    index += 1
  }

  return -1
}

// Convert $...$ to $$...$$ for remark-math (singleDollarTextMath is off).
// Skips markdown link URLs and checks for unescaped inner $ to avoid
// false positives.
function convertSingleDollarLatex(segment: string): string {
  let output = ''
  let index = 0

  while (index < segment.length) {
    // Skip past markdown link URLs: ](...)
    if (segment[index] === ']' && segment[index + 1] === '(') {
      const closeParen = findClosingParen(segment, index + 2)
      if (closeParen !== -1) {
        output += segment.slice(index, closeParen + 1)
        index = closeParen + 1
        continue
      }
    }

    // Skip past existing $$...$$ blocks
    if (segment[index] === '$' && segment[index + 1] === '$') {
      const closeIdx = segment.indexOf('$$', index + 2)
      if (closeIdx !== -1) {
        output += segment.slice(index, closeIdx + 2)
        index = closeIdx + 2
        continue
      }
    }

    // Look for opening single $
    if (
      segment[index] === '$' &&
      index + 1 < segment.length &&
      segment[index + 1] !== '$' &&
      segment[index + 1] !== ' ' &&
      segment[index + 1] !== '\t' &&
      segment[index + 1] !== '\n' &&
      (index === 0 || segment[index - 1] !== '\\') &&
      (index === 0 || segment[index - 1] !== '$')
    ) {
      const closeIndex = findSingleDollarClose(segment, index + 1)
      if (closeIndex !== -1) {
        const inner = segment.slice(index + 1, closeIndex)
        if (!hasUnescapedDollar(inner)) {
          output += `$$${inner}$$`
          index = closeIndex + 1
          continue
        }
      }
    }

    output += segment[index]
    index++
  }

  return output
}

function findClosingParen(segment: string, startIndex: number): number {
  let depth = 1
  let index = startIndex
  while (index < segment.length) {
    if (segment[index] === '(') depth++
    if (segment[index] === ')') {
      depth--
      if (depth === 0) return index
    }
    index++
  }
  return -1
}

function findSingleDollarClose(segment: string, startIndex: number): number {
  let index = startIndex
  while (index < segment.length) {
    // Skip past markdown link URLs: ](...)
    if (segment[index] === ']' && segment[index + 1] === '(') {
      const closeParen = findClosingParen(segment, index + 2)
      if (closeParen !== -1) {
        index = closeParen + 1
        continue
      }
    }

    if (
      segment[index] === '$' &&
      (index + 1 >= segment.length || segment[index + 1] !== '$') &&
      // A $ followed by a digit is a currency opening ($3M, $100), not a math closer
      (index + 1 >= segment.length || !/\d/.test(segment[index + 1])) &&
      segment[index - 1] !== '\\' &&
      segment[index - 1] !== ' ' &&
      segment[index - 1] !== '\t' &&
      segment[index - 1] !== '\n'
    ) {
      return index
    }
    index++
  }
  return -1
}

function hasUnescapedDollar(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '$' && (i === 0 || content[i - 1] !== '\\')) {
      return true
    }
  }
  return false
}

function isEscapedDelimiter(segment: string, delimiterIndex: number): boolean {
  let backslashCount = 0
  let index = delimiterIndex - 1

  while (index >= 0 && segment[index] === '\\') {
    backslashCount += 1
    index -= 1
  }

  return backslashCount % 2 === 1
}

// Convert LaTeX content for copying
// Currently a pass-through - maintains consistency with processLatexTags
// Does NOT wrap content in $$ to avoid breaking unsupported LaTeX
export function convertLatexForCopy(text: string): string {
  return text
}

// Clean up common LaTeX issues that break KaTeX rendering
export function sanitizeUnsupportedMathBlocks(text: string): string {
  // Preserve code blocks as-is
  const parts = text.split(CODE_BLOCK_SPLITTER)

  // Simple cleanup for unsupported commands within math content
  const sanitizeMathContent = (content: string): string => {
    let out = content
    // Remove labels (KaTeX doesn't process \label)
    out = out.replace(/\\label\{[^}]*\}/g, '')
    // KaTeX doesn't support these, so just remove them
    out = out.replace(/\\omicron/g, 'o')
    out = out.replace(/\\circled\{([^}]*)\}/g, '$1')
    // Replace unsupported \mathscr with \mathcal (similar style)
    out = out.replace(/\\mathscr\{([^}]*)\}/g, '\\mathcal{$1}')
    return out
  }

  return parts
    .map((part) => {
      const isCodeBlock =
        part.startsWith('```') ||
        part.startsWith('~~~') ||
        (part.startsWith('`') && part.endsWith('`'))
      if (isCodeBlock) return part

      let transformed = part

      // Clean up $$...$$ blocks (which now include converted \[...\] and \(...\))
      transformed = transformed.replace(
        /\$\$([\s\S]*?)\$\$/g,
        (_m, inner: string) => {
          return '$$' + sanitizeMathContent(inner) + '$$'
        },
      )

      return transformed
    })
    .join('')
}
