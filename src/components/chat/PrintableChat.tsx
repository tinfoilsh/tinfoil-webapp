import { CodeBlock } from '@/components/code-block'
import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { preprocessMarkdown } from '@/utils/markdown-preprocessing'
import { sanitizeUrl } from '@braintree/sanitize-url'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  getMessageAttachments,
  hasMessageAttachments,
} from './attachment-helpers'
import { ensureTimeline } from './ensure-timeline'
import { useMathPlugins } from './renderers/components/use-math-plugins'
import type { Message } from './types'

interface PrintableChatProps {
  messages: Message[]
  printRef: React.RefObject<HTMLDivElement | null>
}

const formatTimestamp = (timestamp: Date): string => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const PrintableMessage = memo(function PrintableMessage({
  message: rawMessage,
}: {
  message: Message
}) {
  const message = ensureTimeline(rawMessage)
  const { remarkPlugins, rehypePlugins } = useMathPlugins()

  const renderContent = (content: string, isUser: boolean) => {
    if (isUser) {
      return <div className="whitespace-pre-wrap break-words">{content}</div>
    }

    const preprocessed = preprocessMarkdown(content)
    const processedContent = processLatexTags(preprocessed)
    const sanitizedContent = sanitizeUnsupportedMathBlocks(processedContent)

    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          hr: () => null,
          code({
            className,
            children,
            ...props
          }: {
            className?: string
            children?: React.ReactNode
            inline?: boolean
          } & React.HTMLAttributes<HTMLElement>) {
            if (props.inline) {
              return (
                <code
                  className={`${className || ''} inline break-words rounded bg-gray-100 px-1.5 py-0.5 align-baseline font-mono text-sm`}
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          pre({ children }: { children?: React.ReactNode }) {
            if (
              children &&
              typeof children === 'object' &&
              'props' in (children as any)
            ) {
              const codeProps = (children as any).props
              const className = codeProps?.className || ''
              const match = /language-([\w+#-]+)/.exec(className)
              const language = match ? match[1] : 'text'
              const code = String(codeProps?.children || '').replace(/\n$/, '')

              return (
                <CodeBlock
                  code={code}
                  language={language}
                  isDarkMode={false}
                  isStreaming={false}
                />
              )
            }
            return <pre>{children}</pre>
          },
          table({ children, node, ...props }: any) {
            return (
              <div className="my-4 w-full overflow-x-auto">
                <table
                  {...props}
                  className="divide-y divide-gray-200"
                  style={{ minWidth: 'max-content' }}
                >
                  {children}
                </table>
              </div>
            )
          },
          thead({ children, node, ...props }: any) {
            return (
              <thead {...props} className="bg-gray-50">
                {children}
              </thead>
            )
          },
          tbody({ children, node, ...props }: any) {
            return (
              <tbody {...props} className="divide-y divide-gray-200 bg-white">
                {children}
              </tbody>
            )
          },
          tr({ children, node, ...props }: any) {
            return <tr {...props}>{children}</tr>
          },
          th({ children, node, ...props }: any) {
            return (
              <th
                {...props}
                className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-700"
                style={{
                  maxWidth: '300px',
                  wordWrap: 'break-word',
                  whiteSpace: 'normal',
                }}
              >
                {children}
              </th>
            )
          },
          td({ children, node, ...props }: any) {
            return (
              <td
                {...props}
                className="px-4 py-3 text-sm text-gray-900"
                style={{
                  maxWidth: '300px',
                  wordWrap: 'break-word',
                  whiteSpace: 'normal',
                }}
              >
                {children}
              </td>
            )
          },
          blockquote({ children, node, ...props }: any) {
            return (
              <blockquote
                {...props}
                className="my-4 border-l-4 border-gray-300 pl-4 text-gray-700"
              >
                {children}
              </blockquote>
            )
          },
          a({ children, href, node, ...props }: any) {
            const sanitizedHref = sanitizeUrl(href)
            return (
              <a
                {...props}
                href={sanitizedHref}
                className="inline align-baseline text-blue-600 underline"
              >
                {children}
              </a>
            )
          },
          strong({ children, node, ...props }: any) {
            return (
              <strong
                {...props}
                className="inline align-baseline font-semibold"
              >
                {children}
              </strong>
            )
          },
          b({ children, node, ...props }: any) {
            return (
              <b {...props} className="inline align-baseline font-semibold">
                {children}
              </b>
            )
          },
          br({ node, ...props }: any) {
            return <br {...props} />
          },
        }}
      >
        {sanitizedContent}
      </ReactMarkdown>
    )
  }

  const isUser = message.role === 'user'

  return (
    <div className="printable-message">
      <div className="printable-role-header">
        <span className="printable-role">{isUser ? 'User' : 'Assistant'}</span>
        <span className="printable-timestamp">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>

      {hasMessageAttachments(message) && (
        <div className="printable-documents">
          <span className="printable-documents-label">Attachments:</span>
          <ul>
            {getMessageAttachments(message).map((a) => (
              <li key={a.id}>{a.fileName}</li>
            ))}
          </ul>
        </div>
      )}

      {message.timeline
        ?.filter((b) => b.type === 'thinking')
        .map((b) => (
          <div key={b.id} className="printable-thinking">
            <div className="printable-thinking-label">Thinking</div>
            <div className="whitespace-pre-wrap text-sm">
              {b.type === 'thinking' ? b.content : ''}
            </div>
          </div>
        ))}

      {message.content && (
        <div className="printable-content prose prose-sm max-w-none">
          {renderContent(message.content, isUser)}
        </div>
      )}
    </div>
  )
})

export const PrintableChat = memo(function PrintableChat({
  messages,
  printRef,
}: PrintableChatProps) {
  return (
    <div ref={printRef} className="printable-chat hidden" aria-hidden="true">
      {messages.map((message, index) => (
        <PrintableMessage
          key={`print-${message.role}-${message.timestamp instanceof Date ? message.timestamp.getTime() : index}`}
          message={message}
        />
      ))}
    </div>
  )
})
