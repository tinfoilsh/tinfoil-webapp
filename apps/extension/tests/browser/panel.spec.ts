import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const WINDOW_SIZE = '1200,900'
let context: BrowserContext
let worker: Worker
let profile: string
let extensionId: string

test.beforeAll(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'tinfoil-panel-test-'))
  const extension = path.join(root, '.output/chrome-mv3')
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--enable-unsafe-extension-debugging',
      `--window-size=${WINDOW_SIZE}`,
    ],
  })
  worker =
    context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'))
  extensionId = new URL(worker.url()).host
  await context.route(/^https?:/, (route) => route.abort())
  await expect
    .poll(() =>
      worker.evaluate(async () => {
        const behavior = await chrome.sidePanel.getPanelBehavior()
        const options = await chrome.sidePanel.getOptions({})
        return behavior.openPanelOnActionClick && options.enabled === false
      }),
    )
    .toBe(true)
})

test.afterAll(async () => {
  await context?.close()
  if (profile) await rm(profile, { recursive: true, force: true })
})

async function togglePanel(page: Page) {
  const session = await context.browser()!.newBrowserCDPSession()
  try {
    const { targetInfos } = await session.send('Target.getTargets', {
      filter: [{ type: 'tab' }],
    })
    const target = targetInfos.find((target) => target.url === page.url())
    expect(target).toBeDefined()
    await session.send('Extensions.triggerAction', {
      id: extensionId,
      targetId: target!.targetId,
    })
  } finally {
    await session.detach()
  }
}

const width = (page: Page) => page.evaluate(() => window.innerWidth)

test('the toolbar opens a panel only in its tab and restores it when that tab is selected again', async () => {
  const first = context.pages()[0]
  await first.goto('about:blank#first')
  const second = await context.newPage()
  await second.goto('about:blank#second')
  await first.bringToFront()
  const fullWidth = await width(first)
  await togglePanel(first)
  await expect.poll(() => width(first)).toBeLessThan(fullWidth)
  const panels = () =>
    worker.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
    )
  await expect.poll(panels).toHaveLength(1)
  const [opened] = await panels()

  await second.bringToFront()
  await expect.poll(() => width(second)).toBe(fullWidth)

  await first.bringToFront()
  const third = await context.newPage()
  await third.goto('about:blank#third')
  await third.bringToFront()
  await expect.poll(() => width(third)).toBe(fullWidth)

  await first.bringToFront()
  await expect.poll(() => width(first)).toBeLessThan(fullWidth)
  expect((await panels()).map((panel) => panel.documentId)).toEqual([
    opened.documentId,
  ])
  await first.goto('about:blank#navigated')
  await expect.poll(() => width(first)).toBeLessThan(fullWidth)

  await togglePanel(first)
  await expect.poll(() => width(first)).toBe(fullWidth)
  await second.bringToFront()
  await togglePanel(second)
  await expect.poll(() => width(second)).toBeLessThan(fullWidth)
  await first.bringToFront()
  await expect.poll(() => width(first)).toBe(fullWidth)
  await togglePanel(first)
  await expect.poll(() => width(first)).toBeLessThan(fullWidth)
  await third.bringToFront()
  await expect.poll(() => width(third)).toBe(fullWidth)
})
