import { Fragment, memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { PluggableList } from 'unified'
import { MarkdownBlocks } from './markdown-blocks'

interface MarkdownOptions {
  remarkPlugins: PluggableList
  rehypePlugins: PluggableList
  components: Components
}

// A block of the text, parsed again only when it or the options change.
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  remarkPlugins,
  rehypePlugins,
  components,
}: MarkdownOptions & { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

// Markdown as it renders whole. A streaming text renders in blocks, so each
// update parses only the block it goes on in.
export function StreamingMarkdown({
  text,
  streaming,
  ...options
}: MarkdownOptions & { text: string; streaming: boolean }) {
  const [splitter] = useState(() => new MarkdownBlocks())
  const blocks = useMemo(
    () => splitter.update(text, options.remarkPlugins, streaming),
    [splitter, text, options.remarkPlugins, streaming],
  )
  return blocks.map((block, index) => (
    <Fragment key={block.start}>
      {/* The line break the whole text renders between blocks. */}
      {index > 0 && '\n'}
      <MarkdownBlock text={block.text} {...options} />
    </Fragment>
  ))
}
