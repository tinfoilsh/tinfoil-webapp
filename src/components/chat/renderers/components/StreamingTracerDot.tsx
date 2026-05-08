'use client'

interface StreamingTracerDotProps {
  className?: string
  label?: string
  tone?: 'primary' | 'secondary'
}

export function StreamingTracerDot({
  className = '',
  label = 'Streaming response',
  tone = 'primary',
}: StreamingTracerDotProps) {
  const toneClass =
    tone === 'secondary' ? 'text-content-muted' : 'text-content-primary'

  return (
    <span
      className={`inline-block size-2.5 shrink-0 animate-tracer-pulse rounded-full bg-current align-middle [contain:paint] ${toneClass} ${className}`}
      role="status"
      aria-label={label}
    />
  )
}
