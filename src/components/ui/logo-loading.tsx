'use client'

import type { AnimationItem } from 'lottie-web'
import lottie from 'lottie-web'
import { useEffect, useRef } from 'react'

// Eagerly fetch the animation JSON so it's ready by the time the component mounts
const animationDataPromise =
  typeof window !== 'undefined'
    ? fetch('/logo-loading-loop.json').then((res) => res.json())
    : Promise.resolve(null)

function LogoAnimation({
  size = 80,
  isLoading = true,
  onFinished,
}: {
  size?: number
  isLoading?: boolean
  onFinished?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<AnimationItem | null>(null)
  const onFinishedRef = useRef(onFinished)

  useEffect(() => {
    onFinishedRef.current = onFinished
  }, [onFinished])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let unmounted = false

    animationDataPromise
      .then((animationData) => {
        if (!animationData || unmounted) return
        const anim = lottie.loadAnimation({
          container,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData,
        })
        animationRef.current = anim
      })
      .catch(() => {})

    return () => {
      unmounted = true
      animationRef.current?.destroy()
      animationRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!isLoading) {
      onFinishedRef.current?.()
    }
  }, [isLoading])

  return <div ref={containerRef} style={{ width: size, height: size }} />
}

export function LogoLoading({
  size = 80,
  isLoading = true,
  onFinished,
}: {
  size?: number
  isLoading?: boolean
  onFinished?: () => void
}) {
  return (
    <div
      className="flex overflow-hidden bg-surface-chat-background"
      style={{
        position: 'fixed',
        inset: 0,
        height: 'var(--app-height, 100dvh)',
        minHeight: '-webkit-fill-available',
      }}
    >
      {/* Skeleton collapsed sidebar rail */}
      <div className="hidden h-full w-12 shrink-0 border-r border-border-subtle bg-surface-chat-background md:block" />

      {/* Main area */}
      <div className="flex flex-1 items-center justify-center">
        <LogoAnimation
          size={size}
          isLoading={isLoading}
          onFinished={onFinished}
        />
      </div>
    </div>
  )
}
