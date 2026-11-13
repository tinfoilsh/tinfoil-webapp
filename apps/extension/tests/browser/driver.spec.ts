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
let server: Server
let origin: string
let context: BrowserContext
let worker: Worker
let profile: string
let fixturePage: Page | undefined

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

test('unselected tabs and arbitrary code cannot be executed', async () => {
  const { tabId } = await startFixture('/?scope')
  await expect(
    execute({ action: 'read', tabId: tabId + 1000 }),
  ).rejects.toThrow('not selected')
  await expect(
    execute({ action: 'navigate', tabId, url: 'javascript:alert(1)' }),
  ).rejects.toThrow('HTTP or HTTPS')
  await expect(execute({ action: 'close', tabId })).rejects.toThrow(
    'created by this task',
  )
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
