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

// Brings an element that is not wholly in view to the middle of it by
// degrees, for the user to follow, and waits for the page to come to rest:
// for no scroll to have happened in so many frames. An element in view is
// left where it is.
export function glideIntoView(
  this: Element,
  restFrames: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0
    let atRest = 0
    const scrolled = () => {
      atRest = 0
    }
    const finish = () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      observer.disconnect()
      removeEventListener('scroll', scrolled, true)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    const rest = () => {
      if (++atRest > restFrames) finish()
      else frame = requestAnimationFrame(rest)
    }
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect()
      if (entry.intersectionRatio === 1) {
        finish()
        return
      }
      addEventListener('scroll', scrolled, true)
      this.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center',
      })
      frame = requestAnimationFrame(rest)
    })
    observer.observe(this)
  })
}

// The mark a task leaves on the tab it works in, for the user to follow: a
// glow around the edge of the page, and, once the task points at something,
// a cursor that travels there and pulses where it presses. The mark takes no
// input from the page it lies over, and it changes inside its own shadow
// tree, where the page's scripts do not watch.
export function markPage(
  tag: string,
  look: {
    ink: string
    glow: string
  },
  // The task the mark is of.
  task: string,
  point: {
    x: number
    y: number
    press: boolean
    minTravelMs: number
    maxTravelMs: number
    pxPerMs: number
  } | null,
): Promise<boolean> {
  const SVG = 'http://www.w3.org/2000/svg'
  const CURSOR_PX = 36
  // Where the arrow's tip sits in its drawing, which is 24 units across.
  const TIP_X = (CURSOR_PX * 4) / 24
  const TIP_Y = (CURSOR_PX * 2) / 24
  const PULSE_PX = 64
  const PRESS_MS = 320
  const RING_MS = 650
  const PULSE_MS = 450
  // How long past its travel time a cursor that never arrives is waited for.
  const LATE_MS = 100
  let host = document.documentElement.querySelector<HTMLElement>(
    `:scope > ${tag}`,
  )
  // A mark another task left on the page is not this task's to show: it is
  // drawn as that task drew it.
  if (!host?.shadowRoot || host.dataset.task !== task) {
    host?.remove()
    const created = document.createElement(tag)
    host = created
    created.setAttribute('aria-hidden', 'true')
    created.dataset.task = task
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(
      ':host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;contain:strict}' +
        '#layer{position:absolute;inset:0}' +
        // A line and a glow in each of two shades, so that one of them shows
        // on a page of any color.
        `#glow{position:absolute;inset:0;box-shadow:inset 0 0 0 2px ${look.ink},inset 0 0 0 3px ${look.glow},inset 0 0 20px 4px ${look.ink},inset 0 0 48px 10px ${look.glow};animation:breathe 2.4s ease-in-out infinite alternate}` +
        '@keyframes breathe{from{opacity:.5}to{opacity:1}}' +
        '@media (prefers-reduced-motion:reduce){#glow{animation:none}}' +
        '#arrow,#ring,#pulse{position:absolute;left:0;top:0}' +
        // The cursor is not shown before the task has pointed. It is left out
        // rather than hidden, so that it is out of sight with the layer.
        `#arrow{width:${CURSOR_PX}px;height:${CURSOR_PX}px;display:none;transform-origin:${TIP_X}px ${TIP_Y}px;filter:drop-shadow(0 2px 4px rgb(0 0 0/.35))}` +
        `#ring,#pulse{width:${PULSE_PX}px;height:${PULSE_PX}px;margin:${-PULSE_PX / 2}px 0 0 ${-PULSE_PX / 2}px;box-sizing:border-box;border-radius:50%;opacity:0}` +
        `#ring{border:3px solid ${look.ink};box-shadow:0 0 0 1px ${look.glow}}` +
        `#pulse{background:${look.ink}}`,
    )
    const tree = created.attachShadow({ mode: 'open' })
    tree.adoptedStyleSheets = [sheet]
    const part = (id: string, ...parts: Element[]) => {
      const element = document.createElement('div')
      element.id = id
      element.append(...parts)
      return element
    }
    const shape = (
      name: string,
      attributes: Record<string, string | number>,
      ...parts: Element[]
    ) => {
      const element = document.createElementNS(SVG, name)
      for (const [attribute, value] of Object.entries(attributes))
        element.setAttribute(attribute, String(value))
      element.append(...parts)
      return element
    }
    tree.append(
      part(
        'layer',
        part('glow'),
        part('pulse'),
        part('ring'),
        shape(
          'svg',
          { id: 'arrow', viewBox: '0 0 24 24' },
          shape('path', {
            d: 'M4 2v17l4.6-4.1 3 6.7 2.7-1.2-3-6.6h6.2z',
            fill: look.ink,
            stroke: '#fff',
            'stroke-width': 1.5,
            'stroke-linejoin': 'round',
          }),
        ),
      ),
    )
    document.documentElement.append(created)
  }
  const tree = host.shadowRoot!
  const layer = tree.getElementById('layer') as HTMLElement
  layer.style.visibility = ''
  if (!point) return Promise.resolve(true)
  const { x, y, press, minTravelMs, maxTravelMs, pxPerMs } = point
  const arrow = tree.getElementById('arrow') as unknown as SVGElement
  const ring = tree.getElementById('ring') as HTMLElement
  const pulse = tree.getElementById('pulse') as HTMLElement
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const at = `translate(${x}px, ${y}px)`
  const to = `translate(${x - TIP_X}px, ${y - TIP_Y}px)`
  // The cursor travels only from a point it was at to another, for longer
  // the farther it goes.
  const from = arrow.style.transform
  const distance = Math.hypot(
    x - Number(arrow.dataset.x),
    y - Number(arrow.dataset.y),
  )
  arrow.dataset.x = String(x)
  arrow.dataset.y = String(y)
  arrow.style.display = 'block'
  arrow.style.transform = to
  ring.style.transform = at
  pulse.style.transform = at
  const travel =
    !from || !distance || still
      ? 0
      : Math.min(maxTravelMs, Math.max(minTravelMs, distance / pxPerMs))
  const arrived = travel
    ? Promise.race([
        arrow.animate([{ transform: from }, { transform: to }], {
          duration: travel,
          easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
        }).finished,
        new Promise((resolve) => setTimeout(resolve, travel + LATE_MS)),
      ])
    : Promise.resolve()
  return arrived.then(() => {
    // Where it presses, the cursor dips and a pulse spreads from its tip.
    if (press && !still) {
      arrow.animate(
        [
          { transform: `${to} scale(1)` },
          { transform: `${to} scale(0.78)`, offset: 0.4 },
          { transform: `${to} scale(1)` },
        ],
        { duration: PRESS_MS, easing: 'ease-in-out' },
      )
      pulse.animate(
        [
          { opacity: 0.4, transform: `${at} scale(0.15)` },
          { opacity: 0, transform: `${at} scale(1)` },
        ],
        { duration: PULSE_MS, easing: 'ease-out' },
      )
      ring.animate(
        [
          { opacity: 0.9, transform: `${at} scale(0.2)` },
          { opacity: 0, transform: `${at} scale(1.5)` },
        ],
        { duration: RING_MS, easing: 'ease-out' },
      )
    }
    return true
  })
}

// Takes the task's mark out of sight, as while the page is captured, or
// brings it back. Says whether the page has one.
export function hideMark(tag: string, hidden: boolean): boolean {
  const FADE_MS = 200
  const layer = document.documentElement
    .querySelector(`:scope > ${tag}`)
    ?.shadowRoot?.getElementById('layer')
  if (!layer) return false
  layer.style.visibility = hidden ? 'hidden' : ''
  // It comes back gently, where it left at once to be out of the capture.
  if (!hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    layer.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FADE_MS,
      easing: 'ease-out',
    })
  return true
}

export function removeMark(tag: string) {
  document.documentElement.querySelector(`:scope > ${tag}`)?.remove()
}
