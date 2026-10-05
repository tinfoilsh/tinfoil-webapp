import type { Attachment, Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import {
  AUTH_ACTIVE_USER_CHANGED_EVENT,
  AUTH_SIGNOUT_REQUESTED_EVENT,
} from '@/constants/auth-events'
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import { sendChatStream } from '@/services/inference/inference-client'
import { requestExplicitSignout } from '@/utils/auth-signout-intent'
import { setCloudSyncEnabled } from '@/utils/cloud-sync-settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { attachmentGet, create, getClient } = vi.hoisted(() => {
  const create = vi.fn()
  return {
    attachmentGet: vi.fn(),
    create,
    getClient: vi.fn(async () => ({ chat: { completions: { create } } })),
  }
})
vi.mock('@/services/sync-enclave/sync-api', () => ({ attachmentGet }))
vi.mock('@/services/inference/tinfoil-client', () => ({
  getTinfoilClient: getClient,
}))

const model: BaseModel = {
  modelName: 'gpt-oss-120b',
  name: 'Test',
  nameShort: 'Test',
  description: '',
  image: '',
  type: 'chat',
  multimodal: true,
}
const document: Attachment = {
  id: 'doc',
  type: 'document',
  fileName: 'scan.pdf',
  encryptionKey: 'key',
}
const payload = {
  textContent: 'important document',
  pages: [{ page: 1, text: 'page text', image: 'AQID', is_scanned: true }],
}
const bytes = () => new TextEncoder().encode(JSON.stringify(payload))
function send(
  attachments: Attachment[] = [document],
  signal = new AbortController().signal,
) {
  const updatedMessages: Message[] = [
    { role: 'user', content: 'summarize', timestamp: new Date(), attachments },
  ]
  return sendChatStream({ model, systemPrompt: '', updatedMessages, signal })
}

describe('document hydration at sendChatStream', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-1')
    setCloudSyncEnabled(true)
    attachmentGet.mockResolvedValue(bytes())
    create.mockResolvedValue({ async *[Symbol.asyncIterator]() {} })
  })

  it('waits for missing document content before building the actual request', async () => {
    let resolve!: (value: Uint8Array) => void
    attachmentGet.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((done) => {
          resolve = done
        }),
    )
    const pending = send()
    await vi.waitFor(() => expect(attachmentGet).toHaveBeenCalledTimes(1))
    expect(create).not.toHaveBeenCalled()
    resolve(bytes())
    await pending
    const content = create.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'user',
    ).content
    expect(content).toContainEqual({
      type: 'text',
      text: 'Page 1 (scanned):\npage text',
    })
    expect(content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AQID' },
    })
    expect(document).not.toHaveProperty('pages')
  })

  it('fails visibly without sending and succeeds on retry after hydration recovers', async () => {
    attachmentGet.mockRejectedValueOnce(new Error('offline'))
    await expect(send()).rejects.toThrow(/document.*retry/i)
    expect(create).not.toHaveBeenCalled()
    await send()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('sends inline documents without auth or attachment reads while sync is disabled', async () => {
    localStorage.clear()
    setCloudSyncEnabled(false)
    await send([{ ...document, ...payload }])
    expect(attachmentGet).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses a missing document while sync is disabled without fetching', async () => {
    setCloudSyncEnabled(false)
    await expect(send()).rejects.toThrow(/enable cloud sync/i)
    expect(attachmentGet).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'classifies an unkeyed missing document as unavailable with sync enabled=%s',
    async (enabled) => {
      setCloudSyncEnabled(enabled)
      for (const encryptionKey of [undefined, '']) {
        await expect(
          send([{ ...document, encryptionKey }]),
        ).rejects.toMatchObject({ reason: 'unavailable' })
      }
      expect(attachmentGet).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('allows guest inline inference after explicit sign-out has completed', async () => {
    localStorage.removeItem(AUTH_ACTIVE_USER_ID)
    setCloudSyncEnabled(false)
    requestExplicitSignout()
    await send([{ ...document, textContent: 'local guest document' }])
    expect(attachmentGet).not.toHaveBeenCalled()
    expect(create.mock.calls[0][0].messages[0].content).toContain(
      'local guest document',
    )
  })

  it.each(['abort', 'account', 'opt-out'])(
    'does not send stale content after %s during hydration',
    async (change) => {
      const controller = new AbortController()
      attachmentGet.mockImplementationOnce(async () => {
        if (change === 'abort') controller.abort()
        if (change === 'account')
          localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
        if (change === 'opt-out') setCloudSyncEnabled(false)
        return bytes()
      })
      await expect(send([document], controller.signal)).rejects.toThrow()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('rejects malformed pages before building an inference request', async () => {
    attachmentGet.mockResolvedValueOnce(
      new TextEncoder().encode('{"pages":[null]}'),
    )
    await expect(send()).rejects.toMatchObject({
      name: 'DocumentHydrationError',
      reason: 'invalid',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('fetches only missing documents and never starts more than one read at a time', async () => {
    let resolve!: (value: Uint8Array) => void
    attachmentGet.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((done) => {
          resolve = done
        }),
    )
    const pending = send([
      { ...document, id: 'inline', textContent: 'already here' },
      document,
      { ...document, id: 'second' },
    ])
    await vi.waitFor(() => expect(attachmentGet).toHaveBeenCalledTimes(1))
    expect(attachmentGet.mock.calls[0][0].id).toBe('doc')
    expect(create).not.toHaveBeenCalled()
    resolve(bytes())
    await pending
    expect(attachmentGet).toHaveBeenCalledTimes(2)
    expect(attachmentGet.mock.calls[1][0].id).toBe('second')
    expect(JSON.stringify(create.mock.calls[0][0].messages)).toContain(
      'already here',
    )
  })

  it.each(['account', 'abort'])(
    'checks %s again after awaiting the inference client',
    async (change) => {
      const controller = new AbortController()
      getClient.mockImplementationOnce(async () => {
        if (change === 'account')
          localStorage.setItem(AUTH_ACTIVE_USER_ID, 'user-2')
        else controller.abort()
        return { chat: { completions: { create } } }
      })
      await expect(send([document], controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it.each([AUTH_ACTIVE_USER_CHANGED_EVENT, AUTH_SIGNOUT_REQUESTED_EVENT])(
    'latches account invalidation from %s even when the user ID is unchanged',
    async (event) => {
      attachmentGet.mockImplementationOnce(async () => {
        window.dispatchEvent(new Event(event))
        return bytes()
      })
      await expect(send()).rejects.toMatchObject({ name: 'AbortError' })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('sends text-only hydrated documents through the real query builder', async () => {
    attachmentGet.mockResolvedValueOnce(
      new TextEncoder().encode('{"textContent":"retained prose"}'),
    )
    await send()
    expect(create.mock.calls[0][0].messages[0].content).toContain(
      'Document contents:\nretained prose',
    )
  })

  it('forwards cancellation to the attachment transport', async () => {
    const controller = new AbortController()
    attachmentGet.mockImplementationOnce(
      (_request, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        }),
    )
    const pending = send([document], controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.waitFor(() => expect(attachmentGet).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejected
    expect(create).not.toHaveBeenCalled()
  })
})
