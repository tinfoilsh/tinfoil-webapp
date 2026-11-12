import type { BrowserAction, BrowserResult } from '@tinfoil/chat-client/types'
import type { Protocol } from 'devtools-protocol'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping'
import { MAX_TABS } from '../config'
import {
  chooseOption,
  inspectElement,
  selectText,
  stableViewport,
} from './element'
import { BrowserError } from './errors'
import { actionSchema, webURL } from './schema'

const PROTOCOL_VERSION = '1.3'
const MAX_NODES = 300
const MAX_SCANNED_NODES = 2000
const MAX_PAGE_CHARS = 16_000
const MAX_LABEL_CHARS = 500
const MAX_IMAGE_SIDE = 1280
const SCREENSHOT_QUALITY = 65
const SCREENSHOT_TTL_MS = 60_000
const MAX_IMAGE_BASE64 = 2 << 20
const MAX_CAPTURE_ATTEMPTS = 3
const STABLE_VIEWPORT_FRAMES = 3
const VIEWPORT_SETTLE_TIMEOUT_MS = 2_000
const SCROLL_DISTANCE = 600
const WAIT_TIMEOUT_MS = 3_000
const ELEMENT_GROUP = 'tinfoil-elements'
const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  Backspace: 8,
} as const

type Session = chrome.debugger.DebuggerSession
type Target = { session: Session; parent?: Session }
type Reference = {
  target: Target
  backendId: number
  role: string
  name: string
  generation: string
}
type Page = {
  targets: Map<string, Target>
  refs: Map<string, Reference>
  generation: string
  screenshot?: {
    id: string
    generation: string
    capturedAt: number
    image: string
    width: number
    height: number
    viewport: Protocol.Page.VisualViewport
    parameters: Protocol.Page.CaptureScreenshotRequest
  }
}
export type TabInfo = { id: number; title: string; url: string }

export class BrowserDriver {
  private readonly pages = new Map<number, Page>()
  private readonly created = new Set<number>()
  private closed = false
  private readonly onEvent = (
    source: Session,
    method: string,
    params?: object,
  ) => {
    const page =
      source.tabId === undefined ? undefined : this.pages.get(source.tabId)
    if (!page) return
    if (
      method === 'Page.frameNavigated' ||
      method === 'Page.frameDetached' ||
      method === 'DOM.documentUpdated'
    ) {
      page.refs.clear()
      page.generation = crypto.randomUUID()
    }
    if (method === 'Target.attachedToTarget') {
      const event = params as Protocol.Target.AttachedToTargetEvent
      if (event.targetInfo.type !== 'iframe') return
      const target = {
        session: { tabId: source.tabId, sessionId: event.sessionId },
        parent: source,
      }
      page.targets.set(event.sessionId, target)
      void this.enable(target).catch(() =>
        this.interrupted(
          'A frame could not be inspected. Pause and select the tab again.',
        ),
      )
    }
    if (method === 'Target.detachedFromTarget') {
      const event = params as Protocol.Target.DetachedFromTargetEvent
      page.targets.delete(event.sessionId)
      page.refs.clear()
    }
    if (method === 'Page.javascriptDialogOpening')
      this.interrupted(
        'A browser dialog needs your attention. Take over, then continue.',
      )
  }
  private readonly onDetach = (source: chrome.debugger.Debuggee) => {
    if (
      source.tabId !== undefined &&
      this.pages.has(source.tabId) &&
      !this.closed
    ) {
      this.pages.delete(source.tabId)
      this.interrupted(
        'Browser control was disconnected. Select the tab again to continue.',
      )
    }
  }

  constructor(
    private readonly signal: AbortSignal,
    private readonly interrupted: (message: string) => void,
  ) {
    chrome.debugger.onEvent.addListener(this.onEvent)
    chrome.debugger.onDetach.addListener(this.onDetach)
  }

  private check() {
    this.signal.throwIfAborted()
    if (this.closed)
      throw new BrowserError('STOPPED', 'Browser control has stopped.')
  }

  private async send<K extends keyof ProtocolMapping.Commands>(
    session: Session,
    method: K,
    params: ProtocolMapping.Commands[K]['paramsType'][0] = {} as ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    this.check()
    try {
      const value = await new Promise<object | undefined>((resolve, reject) => {
        const aborted = () => reject(this.signal.reason)
        this.signal.addEventListener('abort', aborted, { once: true })
        chrome.debugger.sendCommand(session, method, params).then(
          (value) => {
            this.signal.removeEventListener('abort', aborted)
            resolve(value)
          },
          (cause) => {
            this.signal.removeEventListener('abort', aborted)
            reject(cause)
          },
        )
      })
      this.check()
      return value as ProtocolMapping.Commands[K]['returnType']
    } catch (cause) {
      this.signal.throwIfAborted()
      if (cause instanceof BrowserError) throw cause
      throw new BrowserError(
        'COMMAND_FAILED',
        `Chrome could not perform ${method}. Read the page again or take over.`,
      )
    }
  }

  private async enable(target: Target) {
    await this.send(target.session, 'Page.enable')
    await this.send(target.session, 'DOM.enable')
    await this.send(target.session, 'Accessibility.enable')
    await this.send(target.session, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    })
  }

  async attach(tabId: number) {
    this.check()
    if (this.pages.has(tabId)) return
    if (this.pages.size >= MAX_TABS)
      throw new BrowserError('TAB_LIMIT', 'The task has reached its tab limit.')
    const tab = await chrome.tabs.get(tabId)
    webURL(tab.url || '')
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
    const root: Target = { session: { tabId } }
    this.pages.set(tabId, {
      targets: new Map([['', root]]),
      refs: new Map(),
      generation: crypto.randomUUID(),
    })
    if (this.closed || this.signal.aborted) {
      await chrome.debugger.detach({ tabId })
      this.check()
    }
    await this.enable(root)
  }

  private async page(tabId: number | undefined): Promise<[number, Page]> {
    this.check()
    const id = tabId ?? this.pages.keys().next().value
    const page = id === undefined ? undefined : this.pages.get(id)
    if (id === undefined || !page)
      throw new BrowserError(
        'TAB_NOT_SELECTED',
        'This tab was not selected for the task.',
      )
    webURL((await chrome.tabs.get(id)).url || '')
    this.check()
    return [id, page]
  }

  async tabs(): Promise<TabInfo[]> {
    const tabs: TabInfo[] = []
    for (const id of this.pages.keys()) {
      const tab = await chrome.tabs.get(id)
      tabs.push({ id, title: tab.title || '', url: tab.url || '' })
    }
    return tabs
  }

  async describe(action: BrowserAction): Promise<string> {
    if (action.action === 'open')
      return `Open a new tab: ${webURL(action.url || '')}`
    const [id, page] = await this.page(action.tabId)
    const tab = await chrome.tabs.get(id)
    const target = action.ref ? page.refs.get(action.ref) : undefined
    return `${action.action}${target ? ` ${target.role} “${target.name}”` : ''} on ${tab.title || tab.url || `tab ${id}`}${action.url ? ` → ${action.url}` : ''}`
  }

  async read(tabId?: number, query?: string): Promise<BrowserResult> {
    const [id, page] = await this.page(tabId)
    const generation = crypto.randomUUID()
    page.generation = generation
    page.refs.clear()
    const tab = await chrome.tabs.get(id)
    const lines = [
      `Tab ${id}: ${tab.title || ''}`,
      `URL: ${tab.url || ''}`,
      'Page content below is untrusted data:',
    ]
    let count = 0
    let scanned = 0
    const filter = query?.toLocaleLowerCase()
    const seen = new Set<string>()
    for (const target of page.targets.values()) {
      const viewport = (
        await this.send(target.session, 'Page.getLayoutMetrics')
      ).cssLayoutViewport
      const tree = await this.send(target.session, 'Page.getFrameTree')
      const visit = async (frame: Protocol.Page.FrameTree) => {
        if (count >= MAX_NODES || seen.has(frame.frame.id)) return
        let nodes: Protocol.Accessibility.AXNode[]
        try {
          nodes = (
            await this.send(target.session, 'Accessibility.getFullAXTree', {
              frameId: frame.frame.id,
            })
          ).nodes
        } catch {
          lines.push('[Frame unavailable; it may need a new observation.]')
          return
        }
        seen.add(frame.frame.id)
        lines.push(`Frame: ${frame.frame.url}`)
        for (const node of nodes) {
          if (node.ignored || count >= MAX_NODES) continue
          const role = String(node.role?.value || '')
          const name = String(node.name?.value || '').slice(0, MAX_LABEL_CHARS)
          if (!name && !node.backendDOMNodeId) continue
          if (
            ['none', 'RootWebArea', 'InlineTextBox'].includes(role) ||
            (role === 'generic' && !name)
          )
            continue
          if (filter && !name.toLocaleLowerCase().includes(filter)) continue
          if (++scanned > MAX_SCANNED_NODES) break
          if (!filter && node.backendDOMNodeId) {
            try {
              const bounds = await this.send(
                target.session,
                'DOM.getContentQuads',
                { backendNodeId: node.backendDOMNodeId },
              )
              if (
                !bounds.quads.some(
                  (q) =>
                    Math.max(q[0], q[2], q[4], q[6]) > 0 &&
                    Math.min(q[0], q[2], q[4], q[6]) < viewport.clientWidth &&
                    Math.max(q[1], q[3], q[5], q[7]) > 0 &&
                    Math.min(q[1], q[3], q[5], q[7]) < viewport.clientHeight,
                )
              )
                continue
            } catch {
              this.check()
              continue
            }
          }
          const ref = `${generation}:${++count}`
          const actionable =
            node.backendDOMNodeId &&
            !['StaticText', 'RootWebArea', 'LineBreak'].includes(role)
          if (actionable)
            page.refs.set(ref, {
              target,
              backendId: node.backendDOMNodeId!,
              role,
              name,
              generation,
            })
          const state = (node.properties || [])
            .filter((p) =>
              [
                'checked',
                'disabled',
                'expanded',
                'selected',
                'required',
              ].includes(p.name),
            )
            .map((p) => `${p.name}=${String(p.value.value)}`)
            .join(' ')
          let value = ''
          if (node.value?.value && node.backendDOMNodeId) {
            const described = await this.send(
              target.session,
              'DOM.describeNode',
              { backendNodeId: node.backendDOMNodeId },
            )
            const attributes = described.node.attributes || []
            const attribute = (key: string) => {
              const index = attributes.indexOf(key)
              return index < 0 ? '' : attributes[index + 1] || ''
            }
            if (
              attribute('type').toLowerCase() !== 'password' &&
              !/(?:^|\s)(?:cc-|one-time-code|current-password|new-password)/i.test(
                attribute('autocomplete'),
              )
            )
              value = `value=${JSON.stringify(String(node.value.value).slice(0, MAX_LABEL_CHARS))}`
          }
          lines.push(
            `${actionable ? `[${ref}] ` : ''}${role} ${JSON.stringify(name)} ${state} ${value}`,
          )
        }
        for (const child of frame.childFrames || []) await visit(child)
      }
      await visit(tree.frameTree)
    }
    if (page.generation !== generation)
      throw new BrowserError(
        'PAGE_CHANGED',
        'The page navigated while being read. Read it again.',
      )
    if (count >= MAX_NODES)
      lines.push(
        '[Observation limit reached. Scroll to inspect more of the page.]',
      )
    if (scanned >= MAX_SCANNED_NODES)
      lines.push(
        '[Scan limit reached. Use read with text to find a named element.]',
      )
    return { text: lines.join('\n').slice(0, MAX_PAGE_CHARS) }
  }

  private async element(page: Page, ref: string | undefined) {
    const entry = ref ? page.refs.get(ref) : undefined
    if (!entry || entry.generation !== page.generation)
      throw new BrowserError(
        'STALE_ELEMENT',
        'Read the page again to obtain a current element reference.',
      )
    const current = await this.send(
      entry.target.session,
      'Accessibility.getPartialAXTree',
      { backendNodeId: entry.backendId, fetchRelatives: false },
    )
    const node = current.nodes.find(
      (n) => n.backendDOMNodeId === entry.backendId,
    )
    if (
      !node ||
      String(node.name?.value || '').slice(0, MAX_LABEL_CHARS) !== entry.name ||
      String(node.role?.value || '') !== entry.role
    )
      throw new BrowserError(
        'STALE_ELEMENT',
        'The target changed. Read the page again.',
      )
    await this.send(entry.target.session, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: entry.backendId,
    })
    const resolved = await this.send(entry.target.session, 'DOM.resolveNode', {
      backendNodeId: entry.backendId,
      objectGroup: ELEMENT_GROUP,
    })
    const objectId = resolved.object.objectId
    if (!objectId)
      throw new BrowserError(
        'STALE_ELEMENT',
        'The element is no longer available.',
      )
    const inspected = await this.send(
      entry.target.session,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: inspectElement.toString(),
        returnByValue: true,
      },
    )
    const state = inspected.result.value as
      ReturnType<typeof inspectElement> | undefined
    if (
      inspected.exceptionDetails ||
      !state?.connected ||
      !state.visible ||
      state.covered ||
      state.disabled
    )
      throw new BrowserError(
        'ELEMENT_UNAVAILABLE',
        'The element is hidden, covered, disabled, or detached. Read the page again.',
      )
    if (state.sensitive)
      throw new BrowserError(
        'MANUAL_INPUT',
        'Enter passwords, verification codes, and payment details yourself, then continue.',
      )
    if (entry.generation !== page.generation)
      throw new BrowserError(
        'STALE_ELEMENT',
        'The document changed before the action.',
      )
    return { ...entry, objectId }
  }

  private async point(
    target: Target,
    backendId: number,
  ): Promise<{ x: number; y: number }> {
    const quads = await this.send(target.session, 'DOM.getContentQuads', {
      backendNodeId: backendId,
    })
    const q = quads.quads[0]
    if (!q)
      throw new BrowserError(
        'ELEMENT_UNAVAILABLE',
        'The element has no visible bounds.',
      )
    let x = (q[0] + q[2] + q[4] + q[6]) / 4
    let y = (q[1] + q[3] + q[5] + q[7]) / 4
    let current = target
    while (current.parent) {
      const child = await this.send(current.session, 'Page.getFrameTree')
      const owner = await this.send(current.parent, 'DOM.getFrameOwner', {
        frameId: child.frameTree.frame.id,
      })
      const box = (
        await this.send(current.parent, 'DOM.getBoxModel', {
          backendNodeId: owner.backendNodeId,
        })
      ).model.content
      const viewport = (
        await this.send(current.session, 'Page.getLayoutMetrics')
      ).cssLayoutViewport
      const nextX =
        box[0] +
        ((box[2] - box[0]) * x) / viewport.clientWidth +
        ((box[6] - box[0]) * y) / viewport.clientHeight
      y =
        box[1] +
        ((box[3] - box[1]) * x) / viewport.clientWidth +
        ((box[7] - box[1]) * y) / viewport.clientHeight
      x = nextX
      current = this.pages
        .get(target.session.tabId!)!
        .targets.get(current.parent.sessionId || '')!
    }
    return { x, y }
  }

  private async screenshot(
    id: number,
    page: Page,
    attempt = 1,
  ): Promise<BrowserResult> {
    const root = { tabId: id }
    await this.send(root, 'Page.bringToFront')
    const ready = await this.send(root, 'Runtime.evaluate', {
      expression: `(${stableViewport.toString()})(${STABLE_VIEWPORT_FRAMES}, ${VIEWPORT_SETTLE_TIMEOUT_MS})`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (ready.result.value !== true)
      throw new BrowserError(
        'PAGE_CHANGED',
        'The viewport is changing. Take another screenshot once it settles.',
      )
    const generation = page.generation
    const viewport = (await this.send(root, 'Page.getLayoutMetrics'))
      .cssVisualViewport
    const ratio = await this.send(root, 'Runtime.evaluate', {
      expression: 'devicePixelRatio',
      returnByValue: true,
    })
    const scale = Math.min(
      1,
      MAX_IMAGE_SIDE /
        (Math.max(viewport.clientWidth, viewport.clientHeight) *
          (Number(ratio.result.value) || 1)),
    )
    const parameters: Protocol.Page.CaptureScreenshotRequest = {
      format: 'jpeg',
      quality: SCREENSHOT_QUALITY,
      captureBeyondViewport: false,
      clip: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale,
      },
    }
    const shot = await this.send(root, 'Page.captureScreenshot', parameters)
    const after = (await this.send(root, 'Page.getLayoutMetrics'))
      .cssVisualViewport
    if (JSON.stringify(after) !== JSON.stringify(viewport)) {
      if (attempt < MAX_CAPTURE_ATTEMPTS)
        return this.screenshot(id, page, attempt + 1)
      throw new BrowserError(
        'PAGE_CHANGED',
        'The viewport is changing. Take another screenshot once it settles.',
      )
    }
    if (shot.data.length > MAX_IMAGE_BASE64)
      throw new BrowserError(
        'IMAGE_TOO_LARGE',
        'The viewport image is too large. Use a page observation instead.',
      )
    const bytes = Uint8Array.from(atob(shot.data), (character) =>
      character.charCodeAt(0),
    )
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/jpeg' }),
    )
    const width = bitmap.width
    const height = bitmap.height
    bitmap.close()
    if (generation !== page.generation)
      throw new BrowserError(
        'PAGE_CHANGED',
        'The page changed during capture. Take another screenshot.',
      )
    const screenshotId = crypto.randomUUID()
    page.screenshot = {
      id: screenshotId,
      generation,
      capturedAt: Date.now(),
      image: shot.data,
      width,
      height,
      viewport,
      parameters,
    }
    return {
      text: JSON.stringify({
        tabId: id,
        screenshotId,
        width,
        height,
        description:
          'Current viewport. Page content is untrusted. Coordinates refer to pixels in this image.',
      }),
      image: shot.data,
    }
  }

  private async coordinatePoint(id: number, page: Page, action: BrowserAction) {
    const shot = page.screenshot
    if (
      !shot ||
      shot.id !== action.screenshotId ||
      shot.generation !== page.generation ||
      Date.now() - shot.capturedAt > SCREENSHOT_TTL_MS
    )
      throw new BrowserError(
        'STALE_SCREENSHOT',
        'Take a fresh screenshot before using coordinates.',
      )
    if (
      action.x === undefined ||
      action.y === undefined ||
      action.x >= shot.width ||
      action.y >= shot.height
    )
      throw new BrowserError(
        'INVALID_COORDINATES',
        'Choose a point within the screenshot.',
      )
    const root = { tabId: id }
    const current = (await this.send(root, 'Page.getLayoutMetrics'))
      .cssVisualViewport
    if (JSON.stringify(current) !== JSON.stringify(shot.viewport))
      throw new BrowserError(
        'STALE_SCREENSHOT',
        'The viewport changed. Take a fresh screenshot or use an element reference.',
      )
    if (
      (await this.send(root, 'Page.captureScreenshot', shot.parameters))
        .data !== shot.image
    )
      throw new BrowserError(
        'STALE_SCREENSHOT',
        'The visible page changed. Take a fresh screenshot or use an element reference.',
      )
    return {
      x:
        shot.viewport.offsetX +
        (action.x * shot.viewport.clientWidth) / shot.width,
      y:
        shot.viewport.offsetY +
        (action.y * shot.viewport.clientHeight) / shot.height,
    }
  }

  private async mouse(
    root: Session,
    point: { x: number; y: number },
    click: boolean,
  ) {
    await this.send(root, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
    })
    if (click) {
      await this.send(root, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: 'left',
        clickCount: 1,
      })
      await this.send(root, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button: 'left',
        clickCount: 1,
      })
    }
  }

  async execute(input: BrowserAction): Promise<BrowserResult> {
    const action = actionSchema.parse(input)
    this.check()
    if (action.action === 'tabs')
      return { text: JSON.stringify(await this.tabs()) }
    if (action.action === 'open') {
      if (this.pages.size >= MAX_TABS)
        throw new BrowserError(
          'TAB_LIMIT',
          'The task has reached its tab limit.',
        )
      const url = webURL(action.url || '')
      const tab = await chrome.tabs.create({ url, active: true })
      this.created.add(tab.id!)
      await this.attach(tab.id!)
      return this.read(tab.id)
    }
    const [id, page] = await this.page(action.tabId)
    const root: Session = { tabId: id }
    if (action.action === 'read') return this.read(id, action.text)
    if (action.action === 'screenshot') return this.screenshot(id, page)
    if (
      (action.action === 'click' || action.action === 'hover') &&
      action.screenshotId
    ) {
      await this.mouse(
        root,
        await this.coordinatePoint(id, page, action),
        action.action === 'click',
      )
      return this.read(id)
    }
    switch (action.action) {
      case 'navigate':
        await this.send(root, 'Page.navigate', {
          url: webURL(action.url || ''),
        })
        break
      case 'back':
      case 'forward': {
        const history = await this.send(root, 'Page.getNavigationHistory')
        const next =
          history.entries[
            history.currentIndex + (action.action === 'back' ? -1 : 1)
          ]
        if (!next)
          throw new BrowserError(
            'NO_HISTORY',
            'There is no page in that direction.',
          )
        webURL(next.url)
        await this.send(root, 'Page.navigateToHistoryEntry', {
          entryId: next.id,
        })
        break
      }
      case 'switch':
        await chrome.tabs.update(id, { active: true })
        break
      case 'close':
        if (!this.created.has(id))
          throw new BrowserError(
            'TAB_NOT_CREATED',
            'Only tabs created by this task can be closed.',
          )
        this.pages.delete(id)
        await chrome.tabs.remove(id)
        return { text: `Closed tab ${id}.` }
      case 'scroll': {
        const viewport = (await this.send(root, 'Page.getLayoutMetrics'))
          .cssLayoutViewport
        let point = {
          x: viewport.clientWidth / 2,
          y: viewport.clientHeight / 2,
        }
        if (action.ref) {
          const target = await this.element(page, action.ref)
          point = await this.point(target.target, target.backendId)
        }
        await this.send(root, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX: 0,
          deltaY:
            action.direction === 'up' ? -SCROLL_DISTANCE : SCROLL_DISTANCE,
        })
        break
      }
      case 'wait':
        await this.send(root, 'Runtime.evaluate', {
          expression: `new Promise(resolve => { const observer = new MutationObserver(() => done()); const timer = setTimeout(done, ${WAIT_TIMEOUT_MS}); function done() { observer.disconnect(); clearTimeout(timer); resolve(true); } observer.observe(document, {subtree:true, childList:true, attributes:true, characterData:true}); })`,
          awaitPromise: true,
          returnByValue: true,
        })
        break
      default: {
        const target = await this.element(page, action.ref)
        try {
          if (action.action === 'click' || action.action === 'hover') {
            const point = await this.point(target.target, target.backendId)
            await this.mouse(root, point, action.action === 'click')
          } else if (action.action === 'fill') {
            await this.send(target.target.session, 'DOM.focus', {
              backendNodeId: target.backendId,
            })
            const selected = await this.send(
              target.target.session,
              'Runtime.callFunctionOn',
              {
                objectId: target.objectId,
                functionDeclaration: selectText.toString(),
                returnByValue: true,
              },
            )
            if (selected.result.value !== true)
              throw new BrowserError(
                'NOT_EDITABLE',
                'This element is not an editable field.',
              )
            await this.send(target.target.session, 'Input.insertText', {
              text: action.text || '',
            })
          } else if (action.action === 'select') {
            const selected = await this.send(
              target.target.session,
              'Runtime.callFunctionOn',
              {
                objectId: target.objectId,
                functionDeclaration: chooseOption.toString(),
                arguments: [{ value: action.text || '' }],
                returnByValue: true,
              },
            )
            if (selected.result.value !== true)
              throw new BrowserError(
                'NOT_SELECTABLE',
                'Choose an enabled option value from a select element.',
              )
          } else if (action.action === 'press') {
            if (!action.key)
              throw new BrowserError('MISSING_KEY', 'Specify a supported key.')
            await this.send(target.target.session, 'DOM.focus', {
              backendNodeId: target.backendId,
            })
            const key = {
              key: action.key,
              code: action.key,
              windowsVirtualKeyCode: KEY_CODES[action.key],
            }
            await this.send(target.target.session, 'Input.dispatchKeyEvent', {
              type: 'keyDown',
              ...key,
              ...(action.key === 'Enter' ? { text: '\r' } : {}),
            })
            await this.send(target.target.session, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              ...key,
            })
          }
        } finally {
          if (!this.signal.aborted && !this.closed)
            await this.send(
              target.target.session,
              'Runtime.releaseObjectGroup',
              { objectGroup: ELEMENT_GROUP },
            )
        }
      }
    }
    return this.read(id)
  }

  async dispose() {
    this.closed = true
    chrome.debugger.onEvent.removeListener(this.onEvent)
    chrome.debugger.onDetach.removeListener(this.onDetach)
    const tabs = [...this.pages.keys()]
    this.pages.clear()
    await Promise.allSettled(
      tabs.map((tabId) => chrome.debugger.detach({ tabId })),
    )
  }
}
