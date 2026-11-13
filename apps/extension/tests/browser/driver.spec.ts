import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test'
import type { BrowserAction } from '@tinfoil/chat-client/types'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Driver from './driver-entry'

declare global {
  var browserTest: typeof Driver
}
const root = fileURLToPath(new URL('../..', import.meta.url))
const MAX_SNAPSHOT_OBSERVATIONS = 10
// A page that is drawn produces this many animation frames well within the
// deadline; one the browser stopped drawing produces a few at most.
const DRAWN_FRAMES = 20
const DRAWN_FRAMES_DEADLINE_MS = 2_000
let server: Server
let origin: string
let context: BrowserContext
let worker: Worker
let profile: string
let fixturePage: Page | undefined
// The next request for the held page, which the test releases. Held whole,
// the page it replaces stays until then; held after its start, its document
// commits when the request arrives and is parsed only once released.
let held:
  { arrived: () => void; released: Promise<void>; started: boolean } | undefined
function holdNextPage(started: boolean) {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const arrived = new Promise<void>((resolve) => {
    held = { arrived: resolve, released, started }
  })
  return { arrived, release }
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/frame') {
      response.end(
        '<label>Frame name<input id="frame-name"></label><label>Frame password<input type="password" value="frame-secret"></label><button onclick="document.querySelector(\'output\').textContent=\'Frame saved\'">Save frame</button><output></output>',
      )
      return
    }
    if (request.url === '/next') {
      response.end('<h1>Next page</h1>')
      return
    }
    if (request.url === '/links') {
      response.end(
        '<!doctype html><title>Links</title><a href="/held">Technology</a><a href="#details">Details</a><h2 id="details">Details section</h2>',
      )
      return
    }
    if (request.url === '/held') {
      const pending = held
      held = undefined
      const start =
        '<!doctype html><title>Technology</title><h1>Technology</h1>'
      if (pending?.started !== false) response.write(start)
      pending?.arrived()
      void (pending?.released ?? Promise.resolve()).then(() =>
        response.end(
          `${pending?.started === false ? start : ''}<button onclick="document.title='Late clicked'">Late button</button>`,
        ),
      )
      return
    }
    if (request.url === '/form') {
      response.end(
        '<label>Card<input name="autocomplete" autocomplete="section-payment cc-number" value="sensitive-card"></label><label>Locked<input readonly value="fixed"></label><label>Count<input type="number" value="12"></label><label>Draft<input value="clear me"></label><div id="closed"></div><output></output><script>const root=document.querySelector("#closed").attachShadow({mode:"closed"});root.innerHTML="<button>Closed button</button>";root.querySelector("button").onclick=()=>document.querySelector("output").textContent="Closed clicked"</script>',
      )
      return
    }
    if (request.url === '/long') {
      response.end(
        '<button>Top</button><div style="height:2000px"></div><button onclick="this.textContent=\'Bottom saved\'">Bottom</button>',
      )
      return
    }
    response.end(
      `<!doctype html><title>Browser fixture</title><label>Name<input id="name" value="Before"></label><label>Password<input type="password" value="never-send-this"></label><button id="save" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);document.querySelector('output').textContent='Saved '+document.querySelector('#name').value">Save</button><output></output><select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select><div id="shadow"></div><iframe src="/frame"></iframe><iframe src="${origin.replace('localhost', '127.0.0.1')}/frame"></iframe><canvas id="canvas" width="80" height="40"></canvas><script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<button>Shadow button</button>';root.querySelector('button').onclick=()=>document.querySelector('output').textContent='Shadow clicked';const ctx=document.querySelector('#canvas').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,80,40)</script>`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No fixture port')
  origin = `http://localhost:${address.port}`
  profile = await mkdtemp(path.join(tmpdir(), 'tinfoil-extension-test-'))
  const extension = path.join(root, '.output/chrome-mv3')
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  })
  worker =
    context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'))
  const bundle = await build({
    entryPoints: [path.join(root, 'tests/browser/driver-entry.ts')],
    bundle: true,
    minify: true,
    write: false,
    format: 'iife',
    globalName: 'browserTest',
    target: 'chrome142',
    define: { 'import.meta.env': '{}' },
  })
  await worker.evaluate(
    `${bundle.outputFiles[0].text}\nglobalThis.browserTest = browserTest;`,
  )
})
test.afterAll(async () => {
  await context?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (profile) await rm(profile, { recursive: true, force: true })
})

test.afterEach(async () => {
  try {
    if (worker) await worker.evaluate(() => globalThis.browserTest?.stop())
  } finally {
    await fixturePage?.close()
    fixturePage = undefined
  }
})

async function startFixture(suffix = '') {
  const page = await context.newPage()
  fixturePage = page
  await page.goto(`${origin}${suffix}`)
  const tabId = await worker.evaluate(
    (url) => browserTest.start(url),
    page.url(),
  )
  return { page, tabId }
}

function ref(text: string, name: string) {
  const line = text
    .split('\n')
    .find((line) => line.startsWith('[') && line.includes(JSON.stringify(name)))
  const match = line?.match(/^\[([^\]]+)\]/)
  if (!match) throw new Error(`No element named ${name}: ${text}`)
  return match[1]
}
const execute = (action: BrowserAction) =>
  worker.evaluate((action) => browserTest.execute(action), action)

test('real debugger actions edit fields, click, select, reject stale refs and stop', async () => {
  const { page, tabId } = await startFixture()
  const read = await execute({ action: 'read', tabId })
  expect(read.text).not.toContain('never-send-this')
  const oldSave = ref(read.text, 'Save')
  const filled = await execute({
    action: 'fill',
    tabId,
    ref: ref(read.text, 'Name'),
    text: 'Ada',
  })
  await expect(page.locator('#name')).toHaveValue('Ada')
  expect(filled.text).toContain('value="Ada"')
  await expect(
    execute({ action: 'click', tabId, ref: oldSave }),
  ).rejects.toThrow('current element reference')
  const clicked = await execute({
    action: 'click',
    tabId,
    ref: ref(filled.text, 'Save'),
  })
  await expect(page.locator('output').first()).toHaveText('Saved Ada')
  await execute({
    action: 'select',
    tabId,
    ref: ref(clicked.text, 'Color'),
    text: 'blue',
  })
  await expect(page.locator('select')).toHaveValue('blue')
  const current = await execute({ action: 'read', tabId })
  await expect(
    execute({
      action: 'fill',
      tabId,
      ref: ref(current.text, 'Password'),
      text: 'bad',
    }),
  ).rejects.toThrow('passwords')
  const shot = await execute({ action: 'screenshot', tabId })
  expect(Buffer.from(shot.image!, 'base64').subarray(0, 2)).toEqual(
    Buffer.from([0xff, 0xd8]),
  )
  await worker.evaluate(() => browserTest.stop())
  await expect(
    execute({ action: 'click', tabId, ref: ref(current.text, 'Save') }),
  ).rejects.toThrow()
  await expect(page.locator('output').first()).toHaveText('Saved Ada')
})

test('shadow DOM and cross-origin frames expose usable references', async () => {
  const { page, tabId } = await startFixture('/?frames')
  let observation = await execute({ action: 'read', tabId })
  await execute({
    action: 'click',
    tabId,
    ref: ref(observation.text, 'Shadow button'),
  })
  await expect(page.locator('output').first()).toHaveText('Shadow clicked')
  await expect
    .poll(async () => {
      observation = await execute({ action: 'read', tabId })
      return observation.text
        .split('\n')
        .filter((line) => line.includes('button "Save frame"')).length
    })
    .toBe(2)
  for (const index of [0, 1]) {
    const fields = observation.text
      .split('\n')
      .filter((line) => line.includes('textbox "Frame name"'))
    const field = fields[index].match(/^\[([^\]]+)\]/)![1]
    observation = await execute({
      action: 'fill',
      tabId,
      ref: field,
      text: `Frame ${index}`,
    })
    await expect(
      page.frameLocator('iframe').nth(index).locator('#frame-name'),
    ).toHaveValue(`Frame ${index}`)
    expect(observation.text).not.toContain('frame-secret')
    const passwords = observation.text
      .split('\n')
      .filter((line) => line.includes('textbox "Frame password"'))
    const password = passwords[index].match(/^\[([^\]]+)\]/)![1]
    await expect(
      execute({ action: 'fill', tabId, ref: password, text: 'blocked' }),
    ).rejects.toThrow('passwords')
    observation = await execute({ action: 'read', tabId })
  }
  const buttons = observation.text
    .split('\n')
    .filter((line) => line.includes('button "Save frame"'))
  const target = buttons[1].match(/^\[([^\]]+)\]/)![1]
  await execute({ action: 'click', tabId, ref: target })
  await expect(page.frameLocator('iframe').nth(1).locator('output')).toHaveText(
    'Frame saved',
  )
})

test('a click that navigates is answered with the page it leads to, not the one it leaves', async () => {
  const { page, tabId } = await startFixture('/links')
  const read = await execute({ action: 'read', tabId })
  const next = holdNextPage(false)
  try {
    const clicked = worker.evaluate((action) => browserTest.attempt(action), {
      action: 'click',
      tabId,
      ref: ref(read.text, 'Technology'),
    } satisfies BrowserAction)
    await next.arrived
    next.release()
    const result = await clicked
    if (!result.ok) throw new Error(`The click failed with ${result.code}`)
    expect(result.result.text).toContain(`URL: ${origin}/held`)
    expect(result.result.text).toContain('heading "Technology"')
    expect(result.result.text).not.toContain('still loading')
    // What the observation names on the new page can be acted on.
    await execute({
      action: 'click',
      tabId,
      ref: ref(result.result.text, 'Late button'),
    })
    await expect(page).toHaveTitle('Late clicked')
  } finally {
    next.release()
  }
})

test('navigating, going back and forward, and opening a tab are each answered with the page they arrive at', async () => {
  const { page, tabId } = await startFixture('/links')
  const next = holdNextPage(true)
  try {
    const navigated = execute({
      action: 'navigate',
      tabId,
      url: `${origin}/held`,
    })
    await next.arrived
    next.release()
    const arrived = (await navigated).text
    expect(arrived).toContain(`URL: ${origin}/held`)
    expect(arrived).toContain('button "Late button"')
  } finally {
    next.release()
  }
  const back = (await execute({ action: 'back', tabId })).text
  expect(back).toContain(`URL: ${origin}/links`)
  expect(back).toContain('link "Technology"')
  const forward = (await execute({ action: 'forward', tabId })).text
  expect(forward).toContain(`URL: ${origin}/held`)
  expect(forward).toContain('button "Late button"')
  await expect(page).toHaveURL(`${origin}/held`)

  const opened = (await execute({ action: 'open', url: `${origin}/next` })).text
  expect(opened).toContain(`URL: ${origin}/next`)
  expect(opened).toContain('heading "Next page"')
  const openedId = Number(opened.match(/^Tab (\d+):/)?.[1])
  expect(openedId).not.toBe(tabId)
  expect((await execute({ action: 'close', tabId: openedId })).text).toBe(
    `Closed tab ${openedId}.`,
  )

  // An address that cannot be reached is a failure the model can act on.
  expect(
    await worker.evaluate((action) => browserTest.attempt(action), {
      action: 'navigate',
      tabId,
      url: 'http://127.0.0.1:1/',
    } satisfies BrowserAction),
  ).toEqual({ ok: false, code: 'NAVIGATION_FAILED' })
})

test('a link within the page is followed without waiting for another document', async () => {
  const { page, tabId } = await startFixture('/links')
  const read = await execute({ action: 'read', tabId })
  const followed = (
    await execute({
      action: 'click',
      tabId,
      ref: ref(read.text, 'Details'),
    })
  ).text
  await expect(page).toHaveURL(`${origin}/links#details`)
  expect(followed).toContain(`URL: ${origin}/links#details`)
  expect(followed).toContain('heading "Details section"')
  expect(followed).not.toContain('still loading')
})

test('a frame that navigates outdates what was read inside it, not the page around it', async () => {
  const { page, tabId } = await startFixture('/?frame-navigation')
  const read = await execute({ action: 'read', tabId })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const frame = document.querySelector('iframe')!
        frame.addEventListener('load', () => resolve(), { once: true })
        frame.src = '/next'
      }),
  )
  expect(
    await worker.evaluate((action) => browserTest.attempt(action), {
      action: 'click',
      tabId,
      ref: ref(read.text, 'Save frame'),
    } satisfies BrowserAction),
  ).toEqual({ ok: false, code: 'STALE_ELEMENT' })
  await execute({ action: 'click', tabId, ref: ref(read.text, 'Save') })
  await expect(page.locator('output').first()).toHaveText('Saved Before')
})

test('unavailable tabs and arbitrary code cannot be executed', async () => {
  const { tabId } = await startFixture('/?scope')
  await expect(
    execute({ action: 'read', tabId: tabId + 1000 }),
  ).rejects.toThrow('no longer available')
  await expect(
    execute({ action: 'navigate', tabId, url: 'javascript:alert(1)' }),
  ).rejects.toThrow('HTTP or HTTPS')
  await expect(execute({ action: 'close', tabId })).rejects.toThrow(
    'created by this task',
  )
})

test('all web tabs are available as they open, and working in one leaves the focused window alone', async () => {
  const { page, tabId } = await startFixture('/?all-tabs')
  const otherURL = `${origin}/?another-window`
  const opened = context.waitForEvent('page')
  const otherWindow = await worker.evaluate(
    (url) => chrome.windows.create({ url, focused: false }),
    otherURL,
  )
  if (otherWindow?.id === undefined || !otherWindow.tabs?.[0]?.id)
    throw new Error('The second browser window was not created')
  const other = await opened
  await other.waitForLoadState('domcontentloaded')
  const otherId = otherWindow.tabs![0].id!
  const restricted = await worker.evaluate(() =>
    chrome.tabs.create({ url: 'chrome://version', active: false }),
  )
  const focusedWindow = () =>
    worker.evaluate(async () => (await chrome.windows.getLastFocused()).id)
  try {
    const focused = await focusedWindow()
    expect(focused).not.toBe(otherWindow.id)
    const listed = JSON.parse((await execute({ action: 'tabs' })).text) as {
      id: number
      url: string
      active: boolean
    }[]
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: tabId, url: page.url() }),
        expect.objectContaining({ id: otherId, url: otherURL }),
      ]),
    )
    expect(listed.some((tab) => tab.id === restricted.id)).toBe(false)
    await expect(
      execute({ action: 'read', tabId: restricted.id }),
    ).rejects.toThrow('HTTP or HTTPS')
    const read = await execute({ action: 'read', tabId: otherId })
    expect(read.text).toContain(`URL: ${otherURL}`)
    expect(await focusedWindow()).toBe(focused)
    // The task leaves another window's tab as the user has it: its own tab
    // there stays behind the one they brought forward.
    const { windowId } = await worker.evaluate(
      (id) => chrome.tabs.get(id),
      tabId,
    )
    const forward = await worker.evaluate(
      ({ windowId, url }) =>
        chrome.tabs.create({ windowId, url, active: true }),
      { windowId, url: `${origin}/next` },
    )
    try {
      await execute({ action: 'read', tabId })
      expect(
        await worker.evaluate(
          async (id) => (await chrome.tabs.get(id)).active,
          tabId,
        ),
      ).toBe(false)
    } finally {
      await worker.evaluate((id) => chrome.tabs.remove(id), forward.id!)
    }
    // A tab the task has moved on from can close without stopping it.
    await other.close()
    expect((await execute({ action: 'read', tabId })).text).toContain(
      `URL: ${page.url()}`,
    )
  } finally {
    await other.close()
    await worker.evaluate((id) => chrome.tabs.remove(id), restricted.id!)
  }
})

test('a task works on in its tab after the user leaves it, without pulling them back', async () => {
  const { page, tabId } = await startFixture('/?left-behind')
  // A page that animates must go on being drawn while it is out of view.
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent =
      '@keyframes spin{to{transform:rotate(360deg)}}#spinner{width:20px;height:20px;animation:spin 1s linear infinite}'
    const spinner = document.createElement('div')
    spinner.id = 'spinner'
    document.head.append(style)
    document.body.append(spinner)
  })
  const read = await execute({ action: 'read', tabId })
  const elsewhere = await context.newPage()
  try {
    await elsewhere.goto(`${origin}/next`)
    await elsewhere.bringToFront()
    const front = () =>
      worker.evaluate(async (id) => {
        const { windowId } = await chrome.tabs.get(id)
        return (await chrome.tabs.query({ active: true, windowId }))[0].url
      }, tabId)
    // Whether the page goes on drawing frames, which its animation and the
    // task's input both wait on.
    const draws = () =>
      page.evaluate(
        ({ frames, deadlineMs }) =>
          new Promise<boolean>((resolve) => {
            const deadline = setTimeout(() => resolve(false), deadlineMs)
            const next = (left: number) =>
              requestAnimationFrame(() => {
                if (left > 1) return next(left - 1)
                clearTimeout(deadline)
                resolve(true)
              })
            next(frames)
          }),
        { frames: DRAWN_FRAMES, deadlineMs: DRAWN_FRAMES_DEADLINE_MS },
      )
    expect(await front()).toBe(`${origin}/next`)
    expect(await draws()).toBe(true)
    const filled = await execute({
      action: 'fill',
      tabId,
      ref: ref(read.text, 'Name'),
      text: 'Typed unseen',
    })
    await execute({ action: 'click', tabId, ref: ref(filled.text, 'Save') })
    await expect(page.locator('output').first()).toHaveText(
      'Saved Typed unseen',
    )
    expect((await execute({ action: 'screenshot', tabId })).image).toBeTruthy()
    expect(await draws()).toBe(true)
    expect(await front()).toBe(`${origin}/next`)

    // A tab the task opens while the user is elsewhere opens behind theirs.
    const opened = (await execute({ action: 'open', url: `${origin}/form` }))
      .text
    expect(opened).toContain(`URL: ${origin}/form`)
    expect(await front()).toBe(`${origin}/next`)
    const openedId = Number(opened.match(/^Tab (\d+):/)?.[1])
    await execute({ action: 'close', tabId: openedId })
  } finally {
    await elsewhere.close()
  }
})

test('a task the user watches takes them along to the tab it moves to', async () => {
  const { tabId } = await startFixture('/?watched')
  await execute({ action: 'read', tabId })
  const open = async (path: string) => {
    const opened = (await execute({ action: 'open', url: `${origin}${path}` }))
      .text
    expect(opened).toContain(`URL: ${origin}${path}`)
    return Number(opened.match(/^Tab (\d+):/)?.[1])
  }
  const active = (id: number) =>
    worker.evaluate(async (id) => (await chrome.tabs.get(id)).active, id)
  const openedId = await open('/next')
  expect(await active(openedId)).toBe(true)
  await execute({ action: 'switch', tabId })
  expect(await active(tabId)).toBe(true)

  // The task goes on opening tabs after the one it worked in has gone,
  // window and all.
  await worker.evaluate((id) => chrome.windows.create({ tabId: id }), openedId)
  await execute({ action: 'switch', tabId: openedId })
  await execute({ action: 'close', tabId: openedId })
  const laterId = await open('/form')
  await execute({ action: 'close', tabId: laterId })
})

test('tabs a task works in are gathered in a green Tinfoil group until it stops', async () => {
  const { tabId } = await startFixture('/?grouped-task')
  const pages = [await context.newPage(), await context.newPage()]
  const tabOf = (url: string) =>
    worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
      url,
    )
  const groupOf = (id: number) =>
    worker.evaluate(async (id) => {
      const { groupId } = await chrome.tabs.get(id)
      if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return null
      const { title, color } = await chrome.tabGroups.get(groupId)
      return { groupId, title, color }
    }, id)
  try {
    await pages[0].goto(`${origin}/?grouped-second`)
    await pages[1].goto(`${origin}/?grouped-own`)
    const secondId = await tabOf(pages[0].url())
    const ownId = await tabOf(pages[1].url())
    await worker.evaluate(async (id) => {
      const groupId = await chrome.tabs.group({ tabIds: id })
      await chrome.tabGroups.update(groupId, { title: 'Mine', color: 'blue' })
    }, ownId)
    expect(await groupOf(tabId)).toBeNull()

    await execute({ action: 'read', tabId })
    const group = await groupOf(tabId)
    expect(group).toMatchObject({ title: 'Tinfoil', color: 'green' })
    // A tab the task has not worked in is left where it is.
    expect(await groupOf(secondId)).toBeNull()
    await execute({ action: 'read', tabId: secondId })
    expect(await groupOf(secondId)).toEqual(group)
    // A tab in a group of the user's own stays in it.
    await execute({ action: 'read', tabId: ownId })
    expect(await groupOf(ownId)).toMatchObject({ title: 'Mine', color: 'blue' })

    await worker.evaluate(() => browserTest.stop())
    expect(await groupOf(tabId)).toBeNull()
    expect(await groupOf(secondId)).toBeNull()
    expect(await groupOf(ownId)).toMatchObject({ title: 'Mine', color: 'blue' })
  } finally {
    await Promise.all(pages.map((tab) => tab.close()))
  }
})

test('a cursor on the page shows where the task points, out of what it captures, until the task stops', async () => {
  const { page, tabId } = await startFixture('/?cursor')
  const tip = () =>
    page.evaluate(() => {
      const host = document.querySelector('tinfoil-cursor')
      const arrow = host?.shadowRoot?.getElementById('arrow')
      if (!host || !arrow) return null
      const box = arrow.getBoundingClientRect()
      return {
        x: box.left + 4,
        y: box.top + 2,
        takesInput: getComputedStyle(host).pointerEvents !== 'none',
      }
    })
  const center = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const read = await execute({ action: 'read', tabId })
  expect(await tip()).toBeNull()
  await execute({ action: 'click', tabId, ref: ref(read.text, 'Save') })
  await expect(page.locator('output').first()).toHaveText('Saved Before')
  const save = await center('#save')
  const onSave = (await tip())!
  expect(onSave.takesInput).toBe(false)
  expect(Math.abs(onSave.x - save.x)).toBeLessThan(1)
  expect(Math.abs(onSave.y - save.y)).toBeLessThan(1)

  // A capture leaves the cursor out, so one taken with the cursor on the
  // button still matches the page after the cursor has left for the canvas.
  await page.locator('#canvas').evaluate((canvas) =>
    canvas.addEventListener('click', () => {
      document.title = 'Canvas clicked'
    }),
  )
  const canvas = await center('#canvas')
  let clicked = false
  for (
    let observation = 0;
    observation < MAX_SNAPSHOT_OBSERVATIONS && !clicked;
    observation++
  ) {
    const current = await execute({ action: 'read', tabId })
    await execute({ action: 'hover', tabId, ref: ref(current.text, 'Save') })
    const shot = await worker.evaluate(
      (id) => browserTest.attempt({ action: 'screenshot', tabId: id }),
      tabId,
    )
    if (!shot.ok) {
      expect(shot.code).toBe('PAGE_CHANGED')
      continue
    }
    const info = JSON.parse(shot.result.text) as {
      screenshotId: string
      width: number
      height: number
    }
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))
    const result = await worker.evaluate(
      (action) => browserTest.attempt(action),
      {
        action: 'click',
        tabId,
        screenshotId: info.screenshotId,
        x: (canvas.x * info.width) / viewport.width,
        y: (canvas.y * info.height) / viewport.height,
      } as BrowserAction,
    )
    if (result.ok) clicked = true
    else expect(result.code).toBe('STALE_SCREENSHOT')
  }
  expect(clicked).toBe(true)
  await expect(page).toHaveTitle('Canvas clicked')
  const onCanvas = (await tip())!
  expect(Math.abs(onCanvas.x - canvas.x)).toBeLessThan(1)
  expect(Math.abs(onCanvas.y - canvas.y)).toBeLessThan(1)

  await worker.evaluate(() => browserTest.stop())
  expect(await tip()).toBeNull()
})

test('a task can visit more tabs than it keeps attached and releases every attachment when stopped', async () => {
  const { page, tabId } = await startFixture('/?many-tabs-0')
  const extra: Page[] = []
  const ids = [tabId]
  const TAB_COUNT = 10
  try {
    for (let index = 1; index < TAB_COUNT; index++) {
      const tab = await context.newPage()
      extra.push(tab)
      await tab.goto(`${origin}/?many-tabs-${index}`)
      ids.push(
        await worker.evaluate(
          async (url) =>
            (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
          tab.url(),
        ),
      )
    }
    const listed = JSON.parse((await execute({ action: 'tabs' })).text) as {
      id: number
    }[]
    expect(ids.every((id) => listed.some((tab) => tab.id === id))).toBe(true)
    for (const id of ids)
      expect((await execute({ action: 'read', tabId: id })).text).toContain(
        `Tab ${id}: Browser fixture`,
      )
    const attached = () =>
      worker.evaluate(async (ids) => {
        const connected = await Promise.all(
          ids.map(async (id) => {
            try {
              await chrome.debugger.sendCommand(
                { tabId: id },
                'Page.getFrameTree',
              )
              return id
            } catch {
              return null
            }
          }),
        )
        return connected.filter((id) => id !== null).sort()
      }, ids)
    expect(await attached()).toEqual(ids.slice(2).sort())
    expect((await execute({ action: 'read', tabId })).text).toContain(
      `URL: ${page.url()}`,
    )
    expect(await attached()).toEqual([...ids.slice(3), tabId].sort())
    await worker.evaluate(() => browserTest.stop())
    expect(await attached()).toEqual([])
    await expect(page).toHaveURL(`${origin}/?many-tabs-0`)
  } finally {
    await Promise.all(extra.map((tab) => tab.close()))
  }
})

test('coordinate actions use the captured viewport and reject changed screenshots', async () => {
  const { page, tabId } = await startFixture('/?pixels')
  const capture = async () => {
    for (
      let observation = 0;
      observation < MAX_SNAPSHOT_OBSERVATIONS;
      observation++
    ) {
      const result = await worker.evaluate(
        (id) => browserTest.attempt({ action: 'screenshot', tabId: id }),
        tabId,
      )
      if (result.ok)
        return JSON.parse(result.result.text) as {
          screenshotId: string
          width: number
          height: number
        }
      expect(result.code).toBe('PAGE_CHANGED')
    }
    throw new Error('The fixture never produced a stable viewport')
  }
  let x = 0
  let y = 0
  let clicked = false
  for (
    let observation = 0;
    observation < MAX_SNAPSHOT_OBSERVATIONS;
    observation++
  ) {
    await expect(page.locator('output').first()).toHaveText('')
    expect(await page.locator('#save').getAttribute('data-clicks')).toBeNull()
    const info = await capture()
    const box = (await page.locator('#save').boundingBox())!
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }))
    x = ((box.x + box.width / 2) * info.width) / viewport.width
    y = ((box.y + box.height / 2) * info.height) / viewport.height
    const result = await worker.evaluate(
      (action) => browserTest.attempt(action),
      {
        action: 'click',
        tabId,
        screenshotId: info.screenshotId,
        x,
        y,
      } as BrowserAction,
    )
    if (result.ok) {
      clicked = true
      break
    }
    expect(result.code).toBe('STALE_SCREENSHOT')
  }
  if (!clicked)
    throw new Error(
      'The fixture stayed stale; no coordinate click was dispatched',
    )
  await expect(page.locator('output').first()).toHaveText('Saved Before')
  await expect(page.locator('#save')).toHaveAttribute('data-clicks', '1')
  const next = await capture()
  await page.locator('#save').evaluate((button) => {
    button.style.transform = 'translateX(100px)'
  })
  await expect(
    execute({ action: 'click', tabId, screenshotId: next.screenshotId, x, y }),
  ).rejects.toThrow('visible page changed')
  const canvasShot = await capture()
  await page.locator('canvas').evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement))
      throw new Error('Missing canvas fixture')
    const context = canvas.getContext('2d')!
    context.fillStyle = 'blue'
    context.fillRect(0, 0, canvas.width, canvas.height)
  })
  await expect(
    execute({
      action: 'click',
      tabId,
      screenshotId: canvasShot.screenshotId,
      x,
      y,
    }),
  ).rejects.toThrow('visible page changed')
  await expect(page.locator('#save')).toHaveAttribute('data-clicks', '1')
})

test('long pages can be searched and offscreen targets are scrolled into view', async () => {
  const { page, tabId } = await startFixture('/long')
  const visible = await execute({ action: 'read', tabId })
  expect(visible.text).toContain('button "Top"')
  expect(visible.text).not.toContain('button "Bottom"')
  const found = await execute({ action: 'read', tabId, text: 'Bottom' })
  await execute({ action: 'click', tabId, ref: ref(found.text, 'Bottom') })
  await expect(
    page.getByRole('button', { name: 'Bottom saved' }),
  ).toBeInViewport()
})

test('form observations protect payment values and actions handle readonly and closed-shadow controls', async () => {
  const { page, tabId } = await startFixture('/form')
  const observation = await execute({ action: 'read', tabId })
  expect(observation.text).not.toContain('sensitive-card')
  await expect(
    execute({
      action: 'fill',
      tabId,
      ref: ref(observation.text, 'Locked'),
      text: 'overwrite',
    }),
  ).rejects.toThrow('not an editable')
  await execute({
    action: 'click',
    tabId,
    ref: ref(observation.text, 'Closed button'),
  })
  await expect(page.locator('output')).toHaveText('Closed clicked')
  await expect(page.getByLabel('Locked')).toHaveValue('fixed')
  const current = await execute({ action: 'read', tabId })
  const filled = await execute({
    action: 'fill',
    tabId,
    ref: ref(current.text, 'Count'),
    text: '34',
  })
  await expect(page.getByLabel('Count')).toHaveValue('34')
  await execute({
    action: 'fill',
    tabId,
    ref: ref(filled.text, 'Draft'),
    text: '',
  })
  await expect(page.getByLabel('Draft')).toHaveValue('')
})

test('a parent-page overlay prevents clicking an iframe control', async () => {
  const { page, tabId } = await startFixture('/?overlay')
  const observed = await execute({ action: 'read', tabId })
  const buttons = observed.text
    .split('\n')
    .filter((line) => line.includes('button "Save frame"'))
  expect(buttons).toHaveLength(2)
  await page.evaluate(() => {
    const overlay = document.createElement('button')
    overlay.textContent = 'Overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
    overlay.onclick = () => {
      document.querySelector('output')!.textContent = 'Wrong target clicked'
    }
    document.body.append(overlay)
  })
  for (const button of buttons) {
    const target = button.match(/^\[([^\]]+)\]/)![1]
    await expect(
      execute({ action: 'click', tabId, ref: target }),
    ).rejects.toThrow('covered')
  }
  await expect(page.locator('output').first()).toHaveText('')
  await expect(page.frameLocator('iframe').nth(0).locator('output')).toHaveText(
    '',
  )
  await expect(page.frameLocator('iframe').nth(1).locator('output')).toHaveText(
    '',
  )
})

test('a hidden reference fails before input rather than reporting an uncertain action', async () => {
  const { page, tabId } = await startFixture('/?hidden')
  const observation = await execute({ action: 'read', tabId })
  const target = ref(observation.text, 'Save')
  await page.locator('#save').evaluate((button) => {
    button.style.display = 'none'
  })
  const result = await worker.evaluate(
    (action) => browserTest.attempt(action),
    { action: 'click', tabId, ref: target } as BrowserAction,
  )
  expect(result).toEqual({ ok: false, code: 'ELEMENT_UNAVAILABLE' })
  expect(await page.locator('#save').getAttribute('data-clicks')).toBeNull()
  await expect(page.locator('output').first()).toHaveText('')
})
