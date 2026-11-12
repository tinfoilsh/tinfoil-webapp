// These functions are serialized into the inspected document. All arguments
// travel as CDP values; page content is never interpolated into executable code.
export function inspectElement(this: Element) {
  const box = this.getBoundingClientRect()
  const style = getComputedStyle(this)
  const input = this instanceof HTMLInputElement ? this : undefined
  const sensitive =
    input?.type === 'password' ||
    /(?:^|\s)(?:cc-|one-time-code|current-password|new-password)/i.test(
      this.getAttribute('autocomplete') || '',
    )
  const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2))
  const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2))
  let hit = this.ownerDocument.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const nested = hit.shadowRoot.elementFromPoint(x, y)
    if (!nested || nested === hit) break
    hit = nested
  }
  return {
    connected: this.isConnected,
    visible:
      box.width > 0 &&
      box.height > 0 &&
      style.visibility === 'visible' &&
      style.display !== 'none',
    covered: hit !== this && !this.contains(hit),
    disabled: this.matches(':disabled, [aria-disabled="true"]'),
    sensitive,
  }
}

export function selectText(this: Element): boolean {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    this.select()
    return true
  }
  if (this instanceof HTMLElement && this.isContentEditable) {
    const selection = this.ownerDocument.getSelection()
    selection?.selectAllChildren(this)
    return !!selection
  }
  return false
}

export function chooseOption(this: Element, value: string): boolean {
  if (!(this instanceof HTMLSelectElement)) return false
  const options = Array.from(this.options).filter((option) => !option.disabled)
  const exact = options.find((option) => option.value === value)
  const labels = options.filter((option) => option.label === value)
  const selected = exact || (labels.length === 1 ? labels[0] : undefined)
  if (!selected) return false
  this.value = selected.value
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

export function stableViewport(
  frames: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let previous = ''
    let stable = 0
    let frame: number
    const finish = (ready: boolean) => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const inspect = () => {
      const v = visualViewport
      const current = JSON.stringify([
        innerWidth,
        innerHeight,
        scrollX,
        scrollY,
        devicePixelRatio,
        v?.width,
        v?.height,
        v?.offsetLeft,
        v?.offsetTop,
        v?.scale,
      ])
      stable = current === previous ? stable + 1 : 0
      previous = current
      if (stable >= frames) finish(true)
      else frame = requestAnimationFrame(inspect)
    }
    frame = requestAnimationFrame(inspect)
  })
}
