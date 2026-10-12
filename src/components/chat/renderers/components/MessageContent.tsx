import { TooltipProvider } from '@/components/ui/tooltip'
import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { preprocessMarkdown } from '@/utils/markdown-preprocessing'
import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { GeneratingTable } from './GeneratingTable'
import {
  markdownComponents,
  MarkdownRenderingProvider,
} from './markdown-components'
import { useMathPlugins } from './use-math-plugins'

interface MessageContentProps {
  content: string
  isDarkMode: boolean
  isUser?: boolean
  isStreaming?: boolean
  // Maps URL → source title for every inline citation the router attached to
  // the current message. Used to render markdown links as citation pills so
  // they match the visual style of legacy #cite- anchor links.
  citationUrlTitles?: Map<string, string>
}

function hasStreamingMarkdownTableCodeBlock(content: string): boolean {
  const markdownBlockMatch = content.match(/```(?:markdown|md)\n([\s\S]*)$/)
  if (!markdownBlockMatch) return false

  const blockContent = markdownBlockMatch[1]
  if (blockContent.includes('```')) return false

  const lines = blockContent.split('\n')
  let hasHeader = false
  let hasSeparator = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      hasHeader = true
    }
    if (/^\|[\s\-:|]+\|$/.test(trimmed) && trimmed.includes('-')) {
      hasSeparator = true
    }
  }
  return hasHeader && hasSeparator
}

export const MessageContent = memo(function MessageContent({
  content,
  isDarkMode,
  isUser = false,
  isStreaming = false,
  citationUrlTitles,
}: MessageContentProps) {
  const { remarkPlugins, rehypePlugins } = useMathPlugins()
  const sanitizedContent = useMemo(() => {
    const preprocessed = preprocessMarkdown(content)
    const processedContent = processLatexTags(preprocessed)
    return sanitizeUnsupportedMathBlocks(processedContent)
  }, [content])

  const showMarkdownTablePlaceholder = useMemo(() => {
    if (!isStreaming) return false
    return hasStreamingMarkdownTableCodeBlock(content)
  }, [isStreaming, content])

  const renderingOptions = useMemo(
    () => ({
      isDarkMode,
      isStreaming,
      showMarkdownTablePlaceholder,
      citationUrlTitles,
    }),
    [isDarkMode, isStreaming, showMarkdownTablePlaceholder, citationUrlTitles],
  )

  if (isUser) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>
  }

  return (
    <TooltipProvider>
      <div translate="no">
        <MarkdownRenderingProvider value={renderingOptions}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={markdownComponents}
          >
            {sanitizedContent}
          </ReactMarkdown>
        </MarkdownRenderingProvider>
        {showMarkdownTablePlaceholder && <GeneratingTable />}
      </div>
    </TooltipProvider>
  )
})
