import { DEPLOYMENT_ID } from '@/config'
import { UPDATE_RELOADED_FOR_DEPLOYMENT } from '@/constants/storage-keys'
import { logInfo } from '@/utils/error-handling'
import { useEffect } from 'react'

// Where each build publishes the deployment it belongs to (see
// scripts/write-deployment.mjs).
const DEPLOYMENT_PATH = '/deployment.json'
// A page reloads only once it has been out of sight this long, so a look at
// another tab or window never comes back to a page that reloaded.
export const HIDDEN_BEFORE_RELOAD_MS = 30 * 60_000
// How long a page out of sight waits to look again, while something on it is
// in progress or its deployment is still the one the site serves.
export const RECHECK_MS = 15 * 60_000
// A dialog holds whatever the user was doing in it.
const OPEN_DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
])

// Work on the page that a reload would lose, held by the components that
// own it.
const holds = new Set<object>()

// Keeps the page from reloading to a newer deployment while `active`, as
// while a component holds work a reload would lose.
export function useReloadHold(active: boolean) {
  useEffect(() => {
    if (!active) return
    const hold = {}
    holds.add(hold)
    return () => {
      holds.delete(hold)
    }
  }, [active])
}

// The field the user left focused still holds what they were typing.
function typing(element: Element | null) {
  if (element instanceof HTMLTextAreaElement) return !!element.value.trim()
  if (element instanceof HTMLInputElement)
    return TEXT_INPUT_TYPES.has(element.type) && !!element.value.trim()
  return (
    element instanceof HTMLElement &&
    element.isContentEditable &&
    !!element.textContent?.trim()
  )
}

// The page is out of sight and nothing on it is under way.
function idle() {
  return (
    document.visibilityState === 'hidden' &&
    holds.size === 0 &&
    !document.querySelector(OPEN_DIALOG) &&
    !typing(document.activeElement)
  )
}

// The deployment the site serves now, or undefined when it cannot tell.
async function served(signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(DEPLOYMENT_PATH, { cache: 'no-store', signal })
    if (!response.ok) return
    const { id } = (await response.json()) as { id?: unknown }
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return
  }
}

// Reloads the page once the site serves a newer deployment than `current`,
// so a page left open does not keep running code that the services it talks
// to have moved on from. It reloads only a page out of sight with nothing
// under way, and asks for the deployment only then too: WEBCAT reloads a page
// as soon as the page reads a file its deployment changed. A deployment the
// page reloaded for once and still does not run is not reloaded for again.
// Returns a function that stops watching.
export function watchForNewerDeployment(current: string): () => void {
  if (!current) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let checking: AbortController | undefined
  const wait = (ms: number) => {
    timer = setTimeout(() => void check(), ms)
  }
  async function check() {
    if (!idle()) return wait(RECHECK_MS)
    const controller = new AbortController()
    checking = controller
    const latest = await served(controller.signal)
    if (controller.signal.aborted) return
    checking = undefined
    if (
      latest &&
      latest !== current &&
      sessionStorage.getItem(UPDATE_RELOADED_FOR_DEPLOYMENT) !== latest &&
      idle()
    ) {
      sessionStorage.setItem(UPDATE_RELOADED_FOR_DEPLOYMENT, latest)
      logInfo('Reloading into the deployment the site now serves', {
        component: 'ReloadWhenUpdated',
        metadata: { from: current, to: latest },
      })
      window.location.reload()
      return
    }
    wait(RECHECK_MS)
  }
  const stop = () => {
    clearTimeout(timer)
    checking?.abort()
    checking = undefined
  }
  // Each time the page goes out of sight, it waits again before it checks.
  const visibilityChanged = () => {
    stop()
    if (document.visibilityState === 'hidden') wait(HIDDEN_BEFORE_RELOAD_MS)
  }
  document.addEventListener('visibilitychange', visibilityChanged)
  visibilityChanged()
  return () => {
    document.removeEventListener('visibilitychange', visibilityChanged)
    stop()
  }
}

// Watches for a newer deployment while `enabled`.
export function useReloadWhenUpdated(enabled: boolean) {
  useEffect(
    () => (enabled ? watchForNewerDeployment(DEPLOYMENT_ID) : undefined),
    [enabled],
  )
}
