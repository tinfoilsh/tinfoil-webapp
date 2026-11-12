import { UPDATE_RELOADED_FOR_DEPLOYMENT } from '@/constants/storage-keys'
import {
  HIDDEN_BEFORE_RELOAD_MS,
  RECHECK_MS,
  useReloadHold,
  watchForNewerDeployment,
} from '@/services/reload-when-updated'
import { renderHook } from '@testing-library/react'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'

let visibility: DocumentVisibilityState
// What the site answers for /deployment.json.
let published: string
let fetchDeployment: ReturnType<typeof answerDeployment>

function answerDeployment() {
  const answer = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      ({ ok: true, json: async () => JSON.parse(published) }) as Response,
  )
  vi.stubGlobal('fetch', answer)
  return answer
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility,
  )
  vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  published = JSON.stringify({ id: 'dpl_new' })
  fetchDeployment = answerDeployment()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

function watch(current = 'dpl_old') {
  const stop = watchForNewerDeployment(current)
  onTestFinished(stop)
  return stop
}

function show(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

// Lets the time pass, then what it set off settle.
const pass = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.advanceTimersByTimeAsync(0)
}

it('reloads a page left out of sight once the site serves a newer deployment', async () => {
  watch()
  show('hidden')

  await pass(HIDDEN_BEFORE_RELOAD_MS - 1)
  expect(fetchDeployment).not.toHaveBeenCalled()

  await pass(1)
  expect(fetchDeployment).toHaveBeenCalledOnce()
  expect(fetchDeployment).toHaveBeenCalledWith('/deployment.json', {
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  })
  expect(window.location.reload).toHaveBeenCalledOnce()
  expect(sessionStorage.getItem(UPDATE_RELOADED_FOR_DEPLOYMENT)).toBe('dpl_new')
})

it('waits again each time the page comes back into view, and never checks while in view', async () => {
  watch()
  await pass(HIDDEN_BEFORE_RELOAD_MS * 4)

  show('hidden')
  await pass(HIDDEN_BEFORE_RELOAD_MS - 1)
  show('visible')
  await pass(HIDDEN_BEFORE_RELOAD_MS)
  show('hidden')
  await pass(HIDDEN_BEFORE_RELOAD_MS - 1)
  expect(fetchDeployment).not.toHaveBeenCalled()

  await pass(1)
  expect(window.location.reload).toHaveBeenCalledOnce()
})

it('looks again later while the site still serves its deployment', async () => {
  published = JSON.stringify({ id: 'dpl_old' })
  watch()
  show('hidden')
  await pass(HIDDEN_BEFORE_RELOAD_MS)
  expect(fetchDeployment).toHaveBeenCalledOnce()
  expect(window.location.reload).not.toHaveBeenCalled()

  published = JSON.stringify({ id: 'dpl_new' })
  await pass(RECHECK_MS - 1)
  expect(fetchDeployment).toHaveBeenCalledOnce()

  await pass(1)
  expect(fetchDeployment).toHaveBeenCalledTimes(2)
  expect(window.location.reload).toHaveBeenCalledOnce()
})

it('does not reload a page that comes back into view while it checks', async () => {
  let answer!: () => void
  fetchDeployment.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answer = () =>
          resolve({
            ok: true,
            json: async () => ({ id: 'dpl_new' }),
          } as Response)
      }),
  )
  watch()
  show('hidden')
  await pass(HIDDEN_BEFORE_RELOAD_MS)
  expect(fetchDeployment).toHaveBeenCalledOnce()

  show('visible')
  expect(fetchDeployment.mock.calls[0][1]?.signal?.aborted).toBe(true)
  answer()
  await pass(0)
  expect(window.location.reload).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  [
    'a component holds work a reload would lose',
    () => {
      const { rerender } = renderHook(({ active }) => useReloadHold(active), {
        initialProps: { active: true },
      })
      return () => rerender({ active: false })
    },
  ],
  [
    'a dialog is open',
    () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      return () => dialog.remove()
    },
  ],
  [
    'the field left focused holds text',
    () => {
      const field = document.createElement('textarea')
      document.body.append(field)
      field.focus()
      field.value = 'A message I was writing'
      return () => {
        field.value = ''
      }
    },
  ],
])(
  'waits while %s, without asking which deployment the site serves',
  async (_case, start) => {
    const end = start()
    watch()
    show('hidden')
    await pass(HIDDEN_BEFORE_RELOAD_MS + RECHECK_MS)
    expect(fetchDeployment).not.toHaveBeenCalled()

    end()
    await pass(RECHECK_MS)
    expect(fetchDeployment).toHaveBeenCalledOnce()
    expect(window.location.reload).toHaveBeenCalledOnce()
  },
)

it('reloads with an empty field focused', async () => {
  const field = document.createElement('textarea')
  document.body.append(field)
  field.focus()
  watch()
  show('hidden')

  await pass(HIDDEN_BEFORE_RELOAD_MS)
  expect(window.location.reload).toHaveBeenCalledOnce()
})

it('reloads for a deployment once, and again for a newer one', async () => {
  const stopFirst = watch()
  show('hidden')
  await pass(HIDDEN_BEFORE_RELOAD_MS)
  expect(window.location.reload).toHaveBeenCalledOnce()

  // The page the reload loaded still runs the older deployment.
  stopFirst()
  watch()
  await pass(HIDDEN_BEFORE_RELOAD_MS + RECHECK_MS)
  expect(fetchDeployment).toHaveBeenCalledTimes(3)
  expect(window.location.reload).toHaveBeenCalledOnce()

  published = JSON.stringify({ id: 'dpl_newer' })
  await pass(RECHECK_MS)
  expect(window.location.reload).toHaveBeenCalledTimes(2)
  expect(sessionStorage.getItem(UPDATE_RELOADED_FOR_DEPLOYMENT)).toBe(
    'dpl_newer',
  )
})

it('never checks a page built outside Vercel', async () => {
  watch('')
  show('hidden')

  await pass(HIDDEN_BEFORE_RELOAD_MS + RECHECK_MS)
  expect(fetchDeployment).not.toHaveBeenCalled()
})

it('reloads into the deployment a build publishes', async () => {
  const site = mkdtempSync(path.join(tmpdir(), 'deployment-'))
  onTestFinished(() => rmSync(site, { recursive: true, force: true }))
  mkdirSync(path.join(site, 'public'))
  execFileSync(
    process.execPath,
    [path.resolve('scripts/write-deployment.mjs')],
    {
      cwd: site,
      env: { ...process.env, VERCEL_DEPLOYMENT_ID: 'dpl_published' },
    },
  )
  published = readFileSync(path.join(site, 'public/deployment.json'), 'utf8')

  watch('dpl_published')
  show('hidden')
  await pass(HIDDEN_BEFORE_RELOAD_MS)
  expect(fetchDeployment).toHaveBeenCalledOnce()
  expect(window.location.reload).not.toHaveBeenCalled()

  watch('dpl_old')
  await pass(HIDDEN_BEFORE_RELOAD_MS)
  expect(window.location.reload).toHaveBeenCalledOnce()
  expect(sessionStorage.getItem(UPDATE_RELOADED_FOR_DEPLOYMENT)).toBe(
    'dpl_published',
  )
})
