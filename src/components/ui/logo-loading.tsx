'use client'

import type { AnimationItem } from 'lottie-web'
import { useEffect, useRef } from 'react'

// Fetch the animation JSON once, when the first loader mounts. The session
// provider renders the loader on first paint, so importing this module must
// not start network work. Resolve to null on failure: the loader then shows
// no animation.
let animationDataPromise: Promise<unknown> | undefined
function loadAnimationData(): Promise<unknown> {
  animationDataPromise ??= fetch('/logo-loading-loop.json')
    .then((res) => res.json())
    .catch(() => null)
  return animationDataPromise
}

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

    Promise.all([import('lottie-web'), loadAnimationData()])
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
