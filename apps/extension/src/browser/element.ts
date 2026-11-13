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
  const centerX = box.left + box.width / 2
  const centerY = box.top + box.height / 2
  const x = Math.max(0, Math.min(innerWidth - 1, centerX))
  const y = Math.max(0, Math.min(innerHeight - 1, centerY))
  let hit = this.ownerDocument.elementFromPoint(x, y)
  const roots: ShadowRoot[] = []
  for (
    let root = this.getRootNode();
    root instanceof ShadowRoot;
    root = root.host.getRootNode()
  )
    roots.unshift(root)
  for (const root of roots) {
    if (hit !== root.host) break
    hit = root.elementFromPoint(x, y)
  }
  while (hit?.shadowRoot) {
    const nested = hit.shadowRoot.elementFromPoint(x, y)
    if (!nested || nested === hit) break
    hit = nested
  }
  let withinTarget = false
  for (let element = hit; element;) {
    if (element === this) {
      withinTarget = true
      break
    }
    const root = element.getRootNode()
    element =
      element.parentElement || (root instanceof ShadowRoot ? root.host : null)
  }
  return {
    connected: this.isConnected,
    inViewport:
      centerX >= 0 &&
      centerX < innerWidth &&
      centerY >= 0 &&
      centerY < innerHeight,
    visible:
      box.width > 0 &&
      box.height > 0 &&
      style.visibility === 'visible' &&
      style.display !== 'none',
    covered: !withinTarget,
    disabled: this.matches(':disabled, [aria-disabled="true"]'),
    sensitive,
  }
}

export function includesHit(this: Element, node: Node | null): boolean {
  for (let current = node; current;) {
    if (current === this) return true
    const root = current.getRootNode()
    current =
      current.parentNode || (root instanceof ShadowRoot ? root.host : null)
  }
  return false
}

export function selectText(this: Element): boolean {
  if (
    (this instanceof HTMLInputElement &&
      /^(?:text|search|url|tel|email|password|number)$/.test(this.type)) ||
    this instanceof HTMLTextAreaElement
  ) {
    if (this.readOnly) return false
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

export function stableElement(
  this: Element,
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
      if (!this.isConnected) {
        finish(false)
        return
      }
      const box = this.getBoundingClientRect()
      const current = JSON.stringify([
        box.x,
        box.y,
        box.width,
        box.height,
        innerWidth,
        innerHeight,
      ])
      stable = current === previous ? stable + 1 : 0
      previous = current
      if (stable >= frames) finish(true)
      else frame = requestAnimationFrame(inspect)
    }
    frame = requestAnimationFrame(inspect)
  })
}

// The mark a task leaves on the page for the user to follow: a cursor that
// travels to where the task points, and a ring where it presses. It takes no
// input, and it changes inside its own shadow tree, where the page's scripts
// do not watch.
export function pointCursor(
  tag: string,
  color: string,
  x: number,
  y: number,
  press: boolean,
  travelMs: number,
): Promise<boolean> {
  const SVG = 'http://www.w3.org/2000/svg'
  // Where the arrow's tip sits in its drawing.
  const TIP_X = 4
  const TIP_Y = 2
  const RING_MS = 450
  // How long past its travel time a cursor that never arrives is waited for.
  const LATE_MS = 100
  let host = document.documentElement.querySelector<HTMLElement>(
    `:scope > ${tag}`,
  )
  if (!host?.shadowRoot) {
    host?.remove()
    host = document.createElement(tag)
    host.setAttribute('aria-hidden', 'true')
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(
      ':host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;contain:strict}' +
        '#layer{position:absolute;inset:0}' +
        '#arrow,#ring{position:absolute;left:0;top:0}' +
        '#arrow{width:24px;height:24px;filter:drop-shadow(0 1px 2px rgb(0 0 0/.35))}' +
        '#ring{width:32px;height:32px;margin:-16px 0 0 -16px;box-sizing:border-box;border-radius:50%;border:2px solid;opacity:0}',
    )
    const tree = host.attachShadow({ mode: 'open' })
    tree.adoptedStyleSheets = [sheet]
    const layer = document.createElement('div')
    layer.id = 'layer'
    const ring = document.createElement('div')
    ring.id = 'ring'
    ring.style.borderColor = color
    const arrow = document.createElementNS(SVG, 'svg')
    arrow.id = 'arrow'
    arrow.setAttribute('viewBox', '0 0 24 24')
    const shape = document.createElementNS(SVG, 'path')
    shape.setAttribute('d', 'M4 2v17l4.6-4.1 3 6.7 2.7-1.2-3-6.6h6.2z')
    shape.setAttribute('fill', color)
    shape.setAttribute('stroke', '#fff')
    shape.setAttribute('stroke-width', '1.5')
    shape.setAttribute('stroke-linejoin', 'round')
    arrow.append(shape)
    layer.append(ring, arrow)
    tree.append(layer)
    document.documentElement.append(host)
  }
  const tree = host.shadowRoot!
  const layer = tree.getElementById('layer') as HTMLElement
  const arrow = tree.getElementById('arrow') as unknown as SVGElement
  const ring = tree.getElementById('ring') as HTMLElement
  layer.style.visibility = ''
  const at = `translate(${x}px, ${y}px)`
  const to = `translate(${x - TIP_X}px, ${y - TIP_Y}px)`
  // The cursor travels only from a point it was at to another.
  const from = arrow.style.transform
  const moved = arrow.dataset.x !== String(x) || arrow.dataset.y !== String(y)
  arrow.dataset.x = String(x)
  arrow.dataset.y = String(y)
  arrow.style.transform = to
  ring.style.transform = at
  const travel =
    !from || !moved || matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : travelMs
  const arrived = travel
    ? Promise.race([
        arrow.animate([{ transform: from }, { transform: to }], {
          duration: travel,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        }).finished,
        new Promise((resolve) => setTimeout(resolve, travel + LATE_MS)),
      ])
    : Promise.resolve()
  return arrived.then(() => {
    if (press)
      ring.animate(
        [
          { opacity: 0.7, transform: `${at} scale(0.3)` },
          { opacity: 0, transform: `${at} scale(1.4)` },
        ],
        { duration: RING_MS, easing: 'ease-out' },
      )
    return true
  })
}

// Takes the cursor out of sight, as while the page is captured, or shows it
// again. Says whether the page has one.
export function hideCursor(tag: string, hidden: boolean): boolean {
  const layer = document.documentElement
    .querySelector(`:scope > ${tag}`)
    ?.shadowRoot?.getElementById('layer')
  if (!layer) return false
  layer.style.visibility = hidden ? 'hidden' : ''
  return true
}

export function removeCursor(tag: string) {
  document.documentElement.querySelector(`:scope > ${tag}`)?.remove()
}
