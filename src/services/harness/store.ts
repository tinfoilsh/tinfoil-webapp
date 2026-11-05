import { useSyncExternalStore } from 'react'

// How often a hidden page, which draws no animation frames, shows the
// changes staged for its next frame.
export const HIDDEN_PUBLISH_MS = 250
// A render that holds the page longer than a frame is followed by as long
// again without one, so a slow device still answers input and timers.
export const SLOW_RENDER_MS = 16

// A value that code outside React reads and changes synchronously, and that
// components render from. Each change goes through set or update, so
// readers and renders see the same value.
export interface Store<T> {
  get(): T
  set(next: T): void
  update(change: (current: T) => T): void
  subscribe(listener: () => void): () => void
  // The value components render, when it may lag the one code reads.
  shown?(): T
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const set = (next: T) => {
    if (Object.is(next, value)) return
    value = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => value,
    set,
    update: (change) => set(change(value)),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// A store whose staged changes render at most once per animation frame.
// Code reads every change at once; set and update show theirs, and every
// change staged before them, at once.
export interface FrameStore<T> extends Store<T> {
  shown(): T
  stage(next: T): void
}

export function createFrameStore<T>(initial: T): FrameStore<T> {
  let value = initial
  let shown = initial
  const listeners = new Set<() => void>()
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // No staged change shows before then, after a slow render.
  let notBefore = 0
  const hidden = () => document.visibilityState === 'hidden'
  const cancel = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', publishWhenHidden)
    }
    clearTimeout(timer)
    frame = timer = undefined
  }
  const publish = () => {
    cancel()
    if (Object.is(value, shown)) return
    shown = value
    const started = performance.now()
    for (const listener of listeners) listener()
    // React renders a change in a microtask queued as it is notified, which
    // runs before this one.
    queueMicrotask(() => {
      const ended = performance.now()
      const took = ended - started
      notBefore = took > SLOW_RENDER_MS ? ended + took : 0
    })
  }
  // A page hidden while it waits for a frame draws none.
  function publishWhenHidden() {
    if (hidden()) publish()
  }
  const schedule = () => {
    if (frame !== undefined || timer !== undefined) return
    if (hidden()) {
      timer = setTimeout(publish, HIDDEN_PUBLISH_MS)
      return
    }
    frame = requestAnimationFrame(() => {
      frame = undefined
      document.removeEventListener('visibilitychange', publishWhenHidden)
      if (performance.now() < notBefore) schedule()
      else publish()
    })
    document.addEventListener('visibilitychange', publishWhenHidden)
  }
  const set = (next: T) => {
    value = next
    publish()
  }
  return {
    get: () => value,
    shown: () => shown,
    set,
    update: (change) => set(change(value)),
    stage(next) {
      value = next
      if (Object.is(value, shown)) cancel()
      else schedule()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  const shown = store.shown ?? store.get
  return useSyncExternalStore(store.subscribe, shown, shown)
}
