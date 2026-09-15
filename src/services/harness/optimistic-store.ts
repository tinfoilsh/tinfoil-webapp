type Change<T> = { apply: (value: T) => T; pending: boolean }

// Keep pending edits separate from server state so failures can remove one
// edit without reverting later edits or data received in the meantime.
export class OptimisticStore<T> {
  hasLoaded = false
  private changes: Change<T>[] = []
  private listeners = new Set<() => void>()
  private writes: Promise<unknown> = Promise.resolve()
  private readers = 0
  private readVersion = 0
  private value: T

  constructor(
    private base: T,
    private onChange?: (value: T) => void,
  ) {
    this.value = base
  }

  getSnapshot = () => this.value
  getConfirmed = () =>
    this.changes.reduce(
      (value, change) => (change.pending ? value : change.apply(value)),
      this.base,
    )
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    if (!this.readers) {
      while (this.changes[0] && !this.changes[0].pending) {
        this.base = this.changes.shift()!.apply(this.base)
      }
    }
    this.value = this.changes.reduce(
      (value, change) => change.apply(value),
      this.base,
    )
    this.onChange?.(this.value)
    for (const listener of this.listeners) listener()
  }

  set(update: (value: T) => T) {
    this.base = update(this.base)
    this.emit()
  }

  reset(value: T) {
    this.hasLoaded = false
    this.readVersion++
    this.base = value
    this.changes = []
    this.writes = Promise.resolve()
    this.emit()
  }

  async read(
    load: () => Promise<T>,
    signal: AbortSignal,
    merge?: (current: T, incoming: T) => T,
  ) {
    const version = merge ? this.readVersion : ++this.readVersion
    const included = new Set(this.changes.filter((change) => !change.pending))
    this.readers++
    try {
      const value = await load()
      signal.throwIfAborted()
      if (!merge && version !== this.readVersion) return
      const confirmed = this.changes.reduce(
        (current, change) =>
          included.has(change) ? change.apply(current) : current,
        this.base,
      )
      this.base = merge ? merge(confirmed, value) : value
      if (!merge) this.hasLoaded = true
      this.changes = this.changes.filter((change) => !included.has(change))
      this.emit()
    } finally {
      this.readers--
      if (!signal.aborted) this.emit()
    }
  }

  mutate<R>(
    apply: (value: T) => T,
    save: (confirmed: T) => Promise<R>,
    signal: AbortSignal,
    confirm: (value: T, result: R) => T = (value) => apply(value),
  ): Promise<R> {
    if (signal.aborted) return Promise.reject(signal.reason)
    const change = { apply, pending: true }
    this.changes.push(change)
    this.emit()
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        try {
          signal.throwIfAborted()
          const result = await save(this.getConfirmed())
          signal.throwIfAborted()
          change.apply = (value) => confirm(value, result)
          change.pending = false
          this.emit()
          return result
        } catch (cause) {
          this.changes = this.changes.filter((entry) => entry !== change)
          if (!signal.aborted) this.emit()
          throw cause
        }
      })
    this.writes = write
    return write
  }
}
