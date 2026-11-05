import { useLayoutEffect, useRef, useState } from 'react'

type Handlers = Record<string, (...args: never[]) => unknown>

// Functions that keep their identity from render to render and call the
// latest of those given, so a memoized child does not render again only
// because its parent made new ones. The names given first are the ones kept.
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(handlers).map((name) => [
          name,
          (...args: never[]) => latest.current[name](...args),
        ]),
      ) as T,
  )
  return stable
}
