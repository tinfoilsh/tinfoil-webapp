import { useSyncExternalStore } from 'react'

// A value that code outside React reads and changes synchronously, and that
// components render from. Each change goes through set or update, so
// readers and renders see the same value.
export interface Store<T> {
  get(): T
  set(next: T): void
  update(change: (current: T) => T): void
  subscribe(listener: () => void): () => void
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

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
