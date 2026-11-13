import type { BrowserAction } from '@tinfoil/chat-client/types'
import { BrowserDriver } from '../../src/browser/driver'
import { BrowserError } from '../../src/browser/errors'

let task: { driver: BrowserDriver; abort: AbortController } | undefined
// Starts a task on a tab. Its pages lie as they are, wherever the tests run,
// unless a test has them swell.
export async function start(url: string, swells = false) {
  await stop()
  const abort = new AbortController()
  const driver = new BrowserDriver(abort.signal, () => abort.abort(), swells)
  task = { driver, abort }
  try {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
    if (!tab?.id) throw new Error('Fixture tab missing')
    return tab.id
  } catch (cause) {
    await stop()
    throw cause
  }
}
export async function execute(action: BrowserAction) {
  if (!task) throw new Error('Browser control is stopped')
  return task.driver.execute(action)
}
export async function attempt(action: BrowserAction) {
  try {
    return { ok: true as const, result: await execute(action) }
  } catch (cause) {
    if (!(cause instanceof BrowserError)) throw cause
    return { ok: false as const, code: cause.code }
  }
}
export async function stop() {
  const previous = task
  task = undefined
  previous?.abort.abort()
  await previous?.driver.dispose()
}
