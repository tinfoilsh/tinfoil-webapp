'use client'

import type { AnimationItem } from 'lottie-web'
import { useEffect, useRef } from 'react'

// Eagerly fetch the animation JSON so it's ready by the time the component mounts
const animationDataPromise =
  typeof window !== 'undefined'
    ? fetch('/logo-loading-loop.json').then((res) => res.json())
    : Promise.resolve(null)

function LogoAnimation({
  isLoading = true,
  onFinished,
}: {
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

    Promise.all([import('lottie-web'), animationDataPromise])
      .then(([{ default: lottie }, animationData]) => {
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

  return <div ref={containerRef} className="h-20 w-20" />
}

export function LogoLoading({
  isLoading = true,
  onFinished,
}: {
  isLoading?: boolean
  onFinished?: () => void
}) {
  return (
    <div className="app-shell flex overflow-hidden bg-surface-chat-background">
      <div className="flex flex-1 items-center justify-center">
        <LogoAnimation isLoading={isLoading} onFinished={onFinished} />
      </div>
    </div>
  )
}
