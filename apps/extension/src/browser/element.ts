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
// glow around the edge of the page, a slight swelling of the page as through
// a lens, and, once the task points at something, a cursor that travels
// there and pulses where it presses. The mark takes no input from the page
// it lies over, and it changes inside its own shadow tree, where the page's
// scripts do not watch.
export function markPage(
  tag: string,
  look: {
    ink: string
    glow: string
    // How much larger the middle of the page is drawn than its corners, or
    // nothing where the page is left as it lies.
    bulge: number
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
  // How finely the page's swelling is charted. It changes evenly across the
  // page, so a small chart is stretched over it.
  const SWELL_CHART_PX = 128
  const SWELL_MS = 500
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
        '#layer,#under,#lens,#over{position:absolute;inset:0}' +
        '#optics{position:absolute}' +
        '#lens[data-on]{backdrop-filter:url(#swelling)}' +
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
    const layer = part(
      'layer',
      part(
        'under',
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
      part('over', part('glow')),
    )
    tree.append(layer)
    // The page swells under a lens that redraws what lies behind it, each
    // point from one nearer the middle of the page. The cursor lies behind
    // the lens, so it stays on what it points at; the glow lies before it,
    // where it is drawn as it is.
    if (look.bulge) {
      const lens = part('lens')
      const chart = shape('feImage', {
        x: 0,
        y: 0,
        preserveAspectRatio: 'none',
        result: 'chart',
      })
      const swell = shape('animate', {
        id: 'swell',
        attributeName: 'scale',
        from: 0,
        dur: `${SWELL_MS}ms`,
        begin: 'indefinite',
        calcMode: 'spline',
        keyTimes: '0;1',
        keySplines: '0.2 0 0.2 1',
      })
      const shift = shape(
        'feDisplacementMap',
        {
          in: 'SourceGraphic',
          in2: 'chart',
          scale: 0,
          xChannelSelector: 'R',
          yChannelSelector: 'G',
        },
        swell,
      )
      const swelling = shape(
        'filter',
        {
          id: 'swelling',
          filterUnits: 'userSpaceOnUse',
          x: 0,
          y: 0,
          // The chart's channels are distances, to be read as they are drawn.
          'color-interpolation-filters': 'sRGB',
        },
        chart,
        shift,
      )
      const drawn = document.createElement('canvas')
      drawn.width = SWELL_CHART_PX
      drawn.height = SWELL_CHART_PX
      // Charts the swelling for the size the page has. The red and the green
      // of the chart say how far to the side and how far up or down a point
      // is drawn from, as parts of the one distance the filter moves a point
      // by: farthest about the middle of the page, and nowhere at its
      // corners, so that nothing is drawn from beyond its edge.
      const fit = () => {
        const { width, height } = lens.getBoundingClientRect()
        const context = drawn.getContext('2d')
        if (!width || !height || !context) return
        const reach = Math.max(width, height)
        const pixels = context.createImageData(SWELL_CHART_PX, SWELL_CHART_PX)
        for (let row = 0; row < SWELL_CHART_PX; row++)
          for (let column = 0; column < SWELL_CHART_PX; column++) {
            const x = ((column + 0.5) / SWELL_CHART_PX) * 2 - 1
            const y = ((row + 0.5) / SWELL_CHART_PX) * 2 - 1
            const swollen = 1 - (x * x + y * y) / 2
            const at = (row * SWELL_CHART_PX + column) * 4
            pixels.data[at] = 255 * (0.5 - (x * swollen * width) / reach / 2)
            pixels.data[at + 1] =
              255 * (0.5 - (y * swollen * height) / reach / 2)
            pixels.data[at + 3] = 255
          }
        context.putImageData(pixels, 0, 0)
        for (const sized of [swelling, chart]) {
          sized.setAttribute('width', String(width))
          sized.setAttribute('height', String(height))
        }
        chart.setAttribute('href', drawn.toDataURL())
        const farthest = String(look.bulge * reach)
        shift.setAttribute('scale', farthest)
        swell.setAttribute('to', farthest)
      }
      // A page may refuse the pictures made on it, and the chart with them,
      // which would leave the lens to shift the whole page aside. So the
      // page swells only once it has loaded one such picture, and not for a
      // user who asked for less motion, as it sways what scrolls beneath it.
      const allowed = new Image()
      allowed.addEventListener('load', () => {
        if (
          !created.isConnected ||
          matchMedia('(prefers-reduced-motion: reduce)').matches
        )
          return
        fit()
        new ResizeObserver((_, observer) => {
          if (created.isConnected) fit()
          else observer.disconnect()
        }).observe(lens)
        lens.toggleAttribute('data-on', true)
        ;(swell as SVGAnimationElement).beginElement()
      })
      allowed.src = drawn.toDataURL()
      layer.firstElementChild?.after(lens)
      tree.prepend(
        shape('svg', { id: 'optics', width: 0, height: 0 }, swelling),
      )
    }
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
  const tree = document.documentElement.querySelector(
    `:scope > ${tag}`,
  )?.shadowRoot
  const layer = tree?.getElementById('layer')
  if (!tree || !layer) return false
  layer.style.visibility = hidden ? 'hidden' : ''
  // It comes back gently, where it left at once to be out of the capture.
  // The page swells again by degrees of its own: a lens that faded in would
  // have nothing behind it to redraw until it had.
  if (!hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const id of ['under', 'over'])
      tree.getElementById(id)?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: FADE_MS,
        easing: 'ease-out',
      })
    tree.querySelector<SVGAnimationElement>('#swell')?.beginElement()
  }
  return true
}

export function removeMark(tag: string) {
  document.documentElement.querySelector(`:scope > ${tag}`)?.remove()
}
