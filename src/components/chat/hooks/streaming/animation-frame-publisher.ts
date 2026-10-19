type UpdateCallback<T> = (value: T) => void | Promise<void>

export class AnimationFramePublisher<T> {
  private leadingPublished = false
  private cancelled = false
  private pendingFactory: (() => T) | null = null
  private frameId: number | null = null
  private frameCompletion: Promise<void> | null = null
  private resolveFrame: (() => void) | null = null
  private publication = Promise.resolve()

  constructor(private readonly onUpdate: UpdateCallback<T>) {}

  publish(value: T): void {
    this.publishLazy(() => value)
  }

  publishLazy(factory: () => T): void {
    if (this.cancelled) return
    if (!this.leadingPublished) {
      this.leadingPublished = true
      this.publication = this.invoke(factory())
      return
    }
    this.pendingFactory = factory
    if (this.frameCompletion === null) this.scheduleFrame()
  }

  async finish(value: T): Promise<void> {
    if (this.cancelled) return
    if (!this.leadingPublished) {
      this.publish(value)
    } else {
      this.pendingFactory = () => value
      if (document.visibilityState === 'hidden') this.publishPendingNow()
      else if (this.frameCompletion === null) this.scheduleFrame()
    }

    const publishWhenHidden = () => {
      if (document.visibilityState === 'hidden') this.publishPendingNow()
    }
    document.addEventListener('visibilitychange', publishWhenHidden)
    try {
      while (this.frameCompletion) await this.frameCompletion
      await this.publication
    } finally {
      document.removeEventListener('visibilitychange', publishWhenHidden)
    }
  }

  cancel(): void {
    this.cancelled = true
    this.pendingFactory = null
    if (this.frameId !== null) cancelAnimationFrame(this.frameId)
    this.frameId = null
    this.resolveFrame?.()
    this.resolveFrame = null
    this.frameCompletion = null
  }

  private scheduleFrame(): void {
    this.frameCompletion = new Promise<void>((resolve) => {
      this.resolveFrame = resolve
    })
    const completion = this.frameCompletion
    this.frameId = requestAnimationFrame(() => {
      this.frameId = null
      const factory = this.pendingFactory
      this.pendingFactory = null
      if (this.cancelled || !factory) {
        this.finishFrame(completion)
        return
      }
      this.publication = this.publication.then(() => {
        if (this.cancelled) return
        return this.onUpdate(factory())
      })
      void this.publication.then(
        () => this.finishFrame(completion),
        () => this.finishFrame(completion),
      )
    })
  }

  private invoke(value: T): Promise<void> {
    try {
      const publication = Promise.resolve(this.onUpdate(value))
      void publication.catch(() => undefined)
      return publication
    } catch (error) {
      const publication = Promise.reject(error)
      void publication.catch(() => undefined)
      return publication
    }
  }

  private publishPendingNow(): void {
    const factory = this.pendingFactory
    if (!factory) return

    this.pendingFactory = null
    if (this.frameId !== null) cancelAnimationFrame(this.frameId)
    this.frameId = null
    this.resolveFrame?.()
    this.resolveFrame = null
    this.frameCompletion = null
    this.publication = this.publication.then(() => {
      if (this.cancelled) return
      return this.onUpdate(factory())
    })
  }

  private finishFrame(completion: Promise<void>): void {
    if (this.frameCompletion !== completion) return
    this.resolveFrame?.()
    this.resolveFrame = null
    this.frameCompletion = null
    if (!this.cancelled && this.pendingFactory) this.scheduleFrame()
  }
}
