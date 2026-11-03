import { getRendererRegistry } from './renderers/client'
import type { MessageRenderProps } from './renderers/types'

export function MessageRendererHost({
  outOfContext = false,
  ...props
}: MessageRenderProps & {
  // The message is before the chat's latest compaction marker, so the model
  // reads only the marker's summary of it.
  outOfContext?: boolean
}) {
  const renderer = getRendererRegistry().getMessageRenderer(
    props.message,
    props.model,
  )
  const RendererComponent = renderer.render

  return (
    <div
      data-message-role={props.message.role}
      data-out-of-context={outOfContext || undefined}
      role="article"
      aria-label={props.message.role === 'user' ? 'You said' : 'Al said'}
      tabIndex={-1}
      className={outOfContext ? 'opacity-50' : undefined}
    >
      <RendererComponent {...props} />
    </div>
  )
}
