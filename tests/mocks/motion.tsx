import { createElement, forwardRef, type ReactNode } from 'react'

// Control-flow tests render transitions immediately. Browser animation behavior
// is outside happy-dom's implementation of the Web Animations API.
export const AnimatePresence = ({ children }: { children: ReactNode }) =>
  children
const components = new Map<string, ReturnType<typeof forwardRef>>()
export const motion = new Proxy(
  {},
  {
    get: (_target, tag: string) => {
      if (!components.has(tag)) {
        components.set(
          tag,
          forwardRef(function TestMotion(
            {
              initial,
              animate,
              exit,
              transition,
              layout,
              layoutId,
              whileHover,
              whileTap,
              ...props
            }: any,
            ref,
          ) {
            return createElement(tag, { ...props, ref })
          }),
        )
      }
      return components.get(tag)
    },
  },
)
