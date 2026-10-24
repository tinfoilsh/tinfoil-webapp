import type { ChatList } from './chat-list'
import { localSummary, type LocalThreadStore } from './local-threads'
import type { OpenChat, OpenChatResult } from './open-chat'
import { ROUTES } from './protocol'
import { afterLoaded } from './reducer'
import type { RunController } from './run-controller'
import type { HarnessAPI } from './runtime'
import type { Store } from './store'
import type { ThreadPatch, ThreadStore } from './thread-store'
import {
  moveThreadOnDevice,
  moveThreadToCloud,
  moveThreadToDevice,
  placeOnDevice,
  transferInFlight,
  type DeviceChatCopy,
} from './transfer'
import type { Message, Thread, ThreadSummary, TimelineBlock } from './types'

// The id of the block holding a reply's rewritten text when it had none.
const EDITED_CONTENT_ID = 'edited-content'

// A reply with its text rewritten, as the harness rewrites it: its content
// blocks collapse into one holding the text, where the first was.
function rewrittenReply(message: Message, text: string): Message {
  const timeline = message.timeline ?? []
  const first = timeline.findIndex((block) => block.type === 'content')
  const edited: TimelineBlock = {
    id: first < 0 ? EDITED_CONTENT_ID : timeline[first].id,
    type: 'content',
    content: text,
  }
  const blocks = timeline.flatMap((block, index) => [
    ...(index === first && text ? [edited] : []),
    ...(block.type === 'content' ? [] : [block]),
  ])
  if (first < 0 && text) blocks.push(edited)
  const { timeline: _timeline, ...rest } = message
  return {
    ...rest,
    content: text,
    ...(blocks.length ? { timeline: blocks } : {}),
  }
}

export interface ChatContext {
  api: HarnessAPI
  controller: RunController
  open: Store<OpenChat>
  list: ChatList
  // The browser's store of chats on this device, which moves use.
  device: LocalThreadStore
  // The page-memory store of the open temporary chat.
  temporary(): LocalThreadStore
  // The store of a chat: the open chat's own, or the one that lists it.
  storeOf(threadId: string): ThreadStore
  // Chats moving between the cloud and this device, and their moves.
  moving: Map<string, Promise<unknown>>
  reset(): void
  openChat(
    threadId: string,
    options: { local?: boolean },
  ): Promise<OpenChatResult>
}

// The actions on a chat apart from its turns: renaming and its other
// settings, deleting, forking, changing a message, sharing, and moving it
// between the cloud and this device.
// The latest change asked of each chat, so an earlier change answered after
// it does not show the chat as it was before the latest. The actions are
// made again as the chat renders, so the changes are counted here.
const latestUpdate = new Map<string, number>()
let updates = 0

export function chatActions({
  api,
  controller,
  open,
  list,
  device,
  temporary,
  storeOf,
  moving,
  reset,
  openChat,
}: ChatContext) {
  const isOpen = (threadId: string) => open.get().id === threadId
  const showSummary = (thread: ThreadSummary) =>
    controller.view.update((state) => ({
      ...state,
      snapshot: { ...state.snapshot, thread },
    }))
  const requireIdle = (threadId: string) => {
    const { status } = controller.view.get()
    if (
      controller.deviceRuns.get().has(threadId) ||
      controller.startingThread() === threadId ||
      (isOpen(threadId) &&
        (status === 'submitting' ||
          status === 'streaming' ||
          status === 'queued'))
    ) {
      throw transferInFlight()
    }
  }
  // A chat takes no changes until its move has ended, the open chat's
  // reopening included. A change made to a chat during its move would stay
  // with the copy the move deletes.
  async function whileMoving<T>(threadId: string, move: () => Promise<T>) {
    const moved = move()
    moving.set(threadId, moved)
    try {
      return await moved
    } finally {
      if (moving.get(threadId) === moved) moving.delete(threadId)
    }
  }
  // Message actions change one message of the open chat. The change shows
  // at once and goes back when the chat's store refuses it; the chat then
  // shows as its store answers, after the earlier messages the view loaded.
  async function changeMessage(
    index: number,
    change: (
      store: ThreadStore,
      threadId: string,
      messageId: string,
    ) => Promise<Thread | null>,
    changeLoaded: (messages: Message[], messageId: string) => Message[],
  ) {
    const threadId = open.get().id
    const before = controller.view.get().messages
    const messageId = before[index]?.id
    if (!threadId || !messageId || moving.has(threadId)) return
    const shown = controller.track()
    const changed = changeLoaded(before, messageId)
    controller.view.update((state) => ({ ...state, messages: changed }))
    const undo = () => {
      if (shown() && controller.view.get().messages === changed)
        controller.view.update((state) => ({ ...state, messages: before }))
    }
    let thread: Thread | null
    try {
      thread = await change(storeOf(threadId), threadId, messageId)
    } catch (cause) {
      undo()
      throw cause
    }
    if (!thread) undo()
    if (!thread || !shown()) return
    const {
      messages,
      hasOlder,
      revision: _revision,
      presetId: _presetId,
      ...summary
    } = thread
    controller.view.update((state) => ({
      ...state,
      ...afterLoaded(
        { ...state, messages: changeLoaded(state.messages, messageId) },
        messages,
        hasOlder,
      ),
      snapshot: { ...state.snapshot, thread: summary },
    }))
  }
  return {
    // A new title or favorite state shows at once, and goes back when the
    // chat's store refuses it.
    async update(threadId: string, patch: ThreadPatch) {
      if (moving.has(threadId)) return null
      const store = storeOf(threadId)
      const unlist = list.preview(threadId, patch)
      const shown = controller.view.get().snapshot.thread
      const titled =
        shown?.id === threadId && patch.title !== undefined && isOpen(threadId)
          ? { ...shown, title: patch.title, titleState: 'manual' as const }
          : null
      if (titled) showSummary(titled)
      const undo = () => {
        unlist()
        if (shown && titled && controller.view.get().snapshot.thread === titled)
          showSummary(shown)
      }
      const update = ++updates
      latestUpdate.set(threadId, update)
      let summary: ThreadSummary | null
      let latest = false
      try {
        summary = await store.update(threadId, patch)
      } catch (cause) {
        undo()
        throw cause
      } finally {
        latest = latestUpdate.get(threadId) === update
        if (latest) latestUpdate.delete(threadId)
      }
      if (!summary) undo()
      else if (isOpen(threadId) && latest) showSummary(summary)
      return summary
    },
    // A deleted chat leaves the list and the view at once, and is listed
    // again when its store refuses to delete it.
    async remove(threadId: string) {
      // A chat deleted during its move is deleted where the move left it.
      await moving.get(threadId)?.catch(() => {})
      const runId = controller.deviceRuns.get().get(threadId)?.run?.runId
      if (runId) void controller.cancel({ threadId, runId }).catch(() => {})
      const store = storeOf(threadId)
      const undo = list.previewRemoval(threadId)
      if (isOpen(threadId)) reset()
      try {
        await store.remove(threadId)
      } catch (cause) {
        undo()
        throw cause
      }
    },
    // Deletes every chat the user can see here: the harness's stored chats
    // with cloud sync, and the chats kept on this device.
    async removeAll() {
      // A move that ended after the deletion would put its chat back.
      await Promise.allSettled(moving.values())
      let cloudDeletionCompleted = false
      if (api.cloud) {
        await api.post(ROUTES.deleteAll)
        cloudDeletionCompleted = true
      }
      await device.deleteAll()
      reset()
      list.clearCloud({ confirmedEmpty: cloudDeletionCompleted })
      list.deviceThreads.set([])
      return { cloudDeletionCompleted }
    },
    // Forks the open chat from a message into a new chat holding the
    // messages through it, and opens the fork.
    async fork(messageIndex: number) {
      const { id: threadId, temporary } = open.get()
      const messageId = controller.view.get().messages[messageIndex]?.id
      if (!threadId || temporary || !messageId) return null
      const store = storeOf(threadId)
      const shown = controller.track()
      const forkId = await store.fork(threadId, messageId)
      if (!forkId || !shown()) return null
      await openChat(forkId, { local: store.local })
      return forkId
    },
    // Removes one message; its reply, or the message it answers, stays. A
    // chat keeps its last message.
    deleteMessage(index: number) {
      if (controller.view.get().messages.length <= 1) return Promise.resolve()
      return changeMessage(
        index,
        (store, threadId, messageId) =>
          store.deleteMessage(threadId, messageId),
        (messages, messageId) =>
          messages.filter((message) => message.id !== messageId),
      )
    },
    // Rewrites a reply's text in place; later messages stay.
    editReply(index: number, content: string) {
      if (controller.view.get().messages[index]?.role !== 'assistant')
        return Promise.resolve()
      return changeMessage(
        index,
        (store, threadId, messageId) =>
          store.editReply(threadId, messageId, content),
        (messages, messageId) =>
          messages.map((message) =>
            message.id === messageId
              ? rewrittenReply(message, content)
              : message,
          ),
      )
    },
    share: (threadId: string) => storeOf(threadId).share(threadId),
    // Every message before those shown, which the store gives a page at a
    // time.
    async older() {
      const { id: threadId } = open.get()
      if (!threadId) return
      const shown = controller.track()
      while (controller.view.get().hasOlder) {
        const before = controller.view.get().messages[0]?.id
        const thread = await storeOf(threadId).older(threadId, before)
        if (!shown()) return
        let added = 0
        controller.view.update((state) => {
          const earlier = thread.messages.filter(
            (message) =>
              !state.messages.some((shown) => shown.id === message.id),
          )
          added = earlier.length
          return {
            ...state,
            messages: [...earlier, ...state.messages],
            hasOlder: thread.hasOlder,
          }
        })
        if (!added) return
      }
    },
    // Moves a stored chat to this device under the same id. A chat the
    // harness stored a moment ago is put back as it was on the device, so a
    // move that is undone keeps its original attachments.
    async moveToDevice(threadId: string, original?: DeviceChatCopy) {
      requireIdle(threadId)
      return whileMoving(threadId, async () => {
        const moved = original
          ? await placeOnDevice(
              api,
              device,
              original.thread,
              original.originals,
            )
          : await moveThreadToDevice(api, device, threadId)
        list.cloud.remove(threadId)
        list.device.add(localSummary(moved))
        if (isOpen(threadId)) await openChat(threadId, { local: true })
      })
    },
    // Moves a chat from this device to the cloud under the same id, and
    // returns the device copy it replaced.
    async moveToCloud(threadId: string) {
      requireIdle(threadId)
      return whileMoving(threadId, async () => {
        const { summary, original } = await moveThreadToCloud(
          api,
          device,
          threadId,
        )
        list.device.remove(threadId)
        list.cloud.add(summary)
        if (isOpen(threadId)) await openChat(threadId, { local: false })
        return original
      })
    },
    // Keeps the open temporary chat under the same id where new chats are
    // stored: in the cloud with cloud sync, or else on this device. Its
    // title is the one the harness gave it during its first turn.
    async saveTemporary() {
      const { id: threadId, temporary: isTemporary, local } = open.get()
      if (!threadId || !isTemporary || moving.has(threadId)) return
      requireIdle(threadId)
      const cloud = api.cloud && !local
      return whileMoving(threadId, async () => {
        if (cloud) {
          const { summary } = await moveThreadToCloud(
            api,
            temporary(),
            threadId,
          )
          list.cloud.add(summary)
        } else {
          const saved = await moveThreadOnDevice(temporary(), device, threadId)
          list.device.add(localSummary(saved))
        }
        if (isOpen(threadId)) await openChat(threadId, { local: !cloud })
      })
    },
  }
}
