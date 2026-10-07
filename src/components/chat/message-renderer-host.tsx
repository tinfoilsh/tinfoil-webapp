import { getRendererRegistry } from './renderers/client'
import type { MessageRenderProps } from './renderers/types'

export function MessageRendererHost(props: MessageRenderProps) {
  const renderer = getRendererRegistry().getMessageRenderer(
    props.message,
    props.model,
  )
  const RendererComponent = renderer.render

  return (
    <div
      data-message-role={props.message.role}
      role="article"
      aria-label={props.message.role === 'user' ? 'You said' : 'Al said'}
      tabIndex={-1}
    >
      <RendererComponent {...props} />
    </div>
  )
}
