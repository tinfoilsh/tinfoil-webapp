import {
  chromium,
  expect,
  test,
  type BrowserContext,
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
let server: Server
let origin: string
let context: BrowserContext
let worker: Worker
let profile: string

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/frame') {
      response.end(
        '<label>Frame name<input id="frame-name"></label><button onclick="document.querySelector(\'output\').textContent=\'Frame saved\'">Save frame</button><output></output>',
      )
      return
    }
    if (request.url === '/next') {
      response.end('<h1>Next page</h1>')
      return
    }
    if (request.url === '/long') {
      response.end(
        '<button>Top</button><div style="height:2000px"></div><button onclick="this.textContent=\'Bottom saved\'">Bottom</button>',
      )
      return
    }
    response.end(
      `<!doctype html><title>Browser fixture</title><label>Name<input id="name" value="Before"></label><label>Password<input type="password" value="never-send-this"></label><button id="save" onclick="document.querySelector('output').textContent='Saved '+document.querySelector('#name').value">Save</button><output></output><select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select><div id="shadow"></div><iframe src="/frame"></iframe><iframe src="${origin.replace('localhost', '127.0.0.1')}/frame"></iframe><script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<button>Shadow button</button>';root.querySelector('button').onclick=()=>document.querySelector('output').textContent='Shadow clicked'</script>`,
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
  const page = await context.newPage()
  await page.goto(origin)
  const tabId = await worker.evaluate(
    (url) => browserTest.start(url),
    page.url(),
  )
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
  await page.close()
})

test('shadow DOM and cross-origin frames expose usable references', async () => {
  const page = await context.newPage()
  await page.goto(`${origin}/?frames`)
  const tabId = await worker.evaluate(
    (url) => browserTest.start(url),
    page.url(),
  )
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
  const buttons = observation.text
    .split('\n')
    .filter((line) => line.includes('button "Save frame"'))
  const target = buttons[1].match(/^\[([^\]]+)\]/)![1]
  await execute({ action: 'click', tabId, ref: target })
  await expect(page.frameLocator('iframe').nth(1).locator('output')).toHaveText(
    'Frame saved',
  )
  await worker.evaluate(() => browserTest.stop())
  await page.close()
})

test('unselected tabs and arbitrary code cannot be executed', async () => {
  const page = await context.newPage()
  await page.goto(`${origin}/?scope`)
  const tabId = await worker.evaluate(
    (url) => browserTest.start(url),
    page.url(),
  )
  await expect(
    execute({ action: 'read', tabId: tabId + 1000 }),
  ).rejects.toThrow('not selected')
  await expect(
    execute({ action: 'navigate', tabId, url: 'javascript:alert(1)' }),
  ).rejects.toThrow('HTTP or HTTPS')
  await expect(execute({ action: 'close', tabId })).rejects.toThrow(
    'created by this task',
  )
  await worker.evaluate(() => browserTest.stop())
  await page.close()
})

test('coordinate actions use the captured viewport and reject changed screenshots', async () => {
  const page = await context.newPage()
  await page.goto(`${origin}/?pixels`)
  const tabId = await worker.evaluate(
    (url) => browserTest.start(url),
    page.url(),
  )
  const screenshot = await execute({ action: 'screenshot', tabId })
  const box = (await page.locator('#save').boundingBox())!
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }))
  const info = JSON.parse(screenshot.text) as {
    screenshotId: string
    width: number
    height: number
  }
  const x = ((box.x + box.width / 2) * info.width) / viewport.width
  const y = ((box.y + box.height / 2) * info.height) / viewport.height
  await expect(page.locator('output').first()).toHaveText('')
  await execute({
    action: 'click',
    tabId,
    screenshotId: info.screenshotId,
    x,
    y,
  })
  await expect(page.locator('output').first()).toHaveText('Saved Before')
  const next = JSON.parse(
    (await execute({ action: 'screenshot', tabId })).text,
  ) as typeof info
  await page.locator('#save').evaluate((button) => {
    button.style.transform = 'translateX(100px)'
  })
  await expect(
    execute({ action: 'click', tabId, screenshotId: next.screenshotId, x, y }),
  ).rejects.toThrow('visible page changed')
  await worker.evaluate(() => browserTest.stop())
  await page.close()
})

test('long pages can be searched and offscreen targets are scrolled into view', async () => {
  const page = await context.newPage()
  await page.goto(`${origin}/long`)
  const tabId = await worker.evaluate(
    (url) => browserTest.start(url),
    page.url(),
  )
  const visible = await execute({ action: 'read', tabId })
  expect(visible.text).toContain('button "Top"')
  expect(visible.text).not.toContain('button "Bottom"')
  const found = await execute({ action: 'read', tabId, text: 'Bottom' })
  await execute({ action: 'click', tabId, ref: ref(found.text, 'Bottom') })
  await expect(
    page.getByRole('button', { name: 'Bottom saved' }),
  ).toBeInViewport()
  await worker.evaluate(() => browserTest.stop())
  await page.close()
})
