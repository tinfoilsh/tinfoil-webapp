import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { preprocessMarkdown } from '@/utils/markdown-preprocessing'
import { StepMarkdown as SharedStepMarkdown } from '@tinfoil/chat-ui/StepMarkdown'
import { useMemo } from 'react'
import { useMathPlugins } from './use-math-plugins'

// Markdown as the details of a step show it, with the math a reply's
// thoughts write.
export function StepMarkdown({
  content,
  isStreaming = false,
}: {
  content: string
  isStreaming?: boolean
}) {
  const { remarkPlugins, rehypePlugins } = useMathPlugins()
  const sanitizedContent = useMemo(() => {
    const preprocessed = preprocessMarkdown(content)
    const processedContent = processLatexTags(preprocessed)
    return sanitizeUnsupportedMathBlocks(processedContent)
  }, [content])

  return (
    <SharedStepMarkdown
      content={sanitizedContent}
      isStreaming={isStreaming}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    />
  )
}
