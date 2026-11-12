import type { BrowserAction } from '@tinfoil/chat-client/types'
import { BrowserDriver } from '../../src/browser/driver'

let driver: BrowserDriver
let abort: AbortController
export async function start(url: string) {
  abort = new AbortController()
  driver = new BrowserDriver(abort.signal, () => abort.abort())
  const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
  if (!tab?.id) throw new Error('Fixture tab missing')
  await driver.attach(tab.id)
  return tab.id
}
export function execute(action: BrowserAction) {
  return driver.execute(action)
}
export async function stop() {
  abort.abort()
  await driver.dispose()
}
