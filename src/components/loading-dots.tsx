import { memo } from 'react'
import { StreamingTracerDot } from './chat/renderers/components/StreamingTracerDot'

export const LoadingDots = memo(function LoadingDots({
  size = 'default',
}: {
  size?: 'default' | 'small'
}) {
  return (
    <StreamingTracerDot
      tone="secondary"
      className={size === 'small' ? 'scale-90' : ''}
    />
  )
})
