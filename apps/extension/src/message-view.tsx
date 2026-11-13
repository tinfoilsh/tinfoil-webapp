import type { Message } from '@tinfoil/chat-client/types'
import {
  StreamingMarkdown,
  type MarkdownComponents,
} from '@tinfoil/chat-ui/StreamingMarkdown'
import remarkGfm from 'remark-gfm'
import { webURL } from './browser/schema'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS: [] = []
const MARKDOWN_COMPONENTS: MarkdownComponents = {
  a: ({ href, children }) => {
    let safe: string | undefined
    try {
      safe = webURL(href || '')
    } catch {
      safe = undefined
    }
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
  },
  img: ({ alt }) => <span>[Image: {alt || 'image'}]</span>,
}

export function MessageView({
  message,
  streaming,
}: {
  message: Message
  streaming: boolean
}) {
  const tools = (message.timeline || []).filter(
    (block) => block.type === 'tool_call',
  )
  const content = (message.timeline || []).filter(
    (block) => block.type === 'content',
  )
  const text = content.length
    ? content.map((block) => block.content ?? '').join('\n\n')
    : (message.content ?? '')
  return (
    <article
      className={`message ${message.role === 'user' ? 'user-message' : ''}`}
    >
      <div className="message-label">
        {message.role === 'user' ? 'You' : 'Tinfoil'}
      </div>
      {!!tools.length && (
        <details className="steps">
          <summary>
            {tools.length} browser {tools.length === 1 ? 'step' : 'steps'}
          </summary>
          {tools.map((tool) => (
            <div key={tool.id} className="step">
              <strong>
                {tool.name === 'browser_action' ? 'Browser action' : tool.name}
              </strong>
              <pre>{tool.arguments}</pre>
              {tool.result !== undefined && (
                <pre>
                  {typeof tool.result === 'string'
                    ? tool.result
                    : JSON.stringify(tool.result, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </details>
      )}
      {message.role === 'user' ? (
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      ) : (
        <div className="markdown">
          <StreamingMarkdown
            text={text}
            streaming={streaming}
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          />
        </div>
      )}
    </article>
  )
}
