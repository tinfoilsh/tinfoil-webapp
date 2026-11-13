import type { Dictation } from '@tinfoil/chat-client/dictation'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import type { ComposerHandle } from './composer'

// A composer's dictation: the microphone it opens, and the text of what was
// dictated in its chat, which joins the end of its draft.
export function useDictation({
  dictation,
  chatId,
  input,
  setInput,
  composer,
  segmentSeconds,
  persist,
  onError,
}: {
  dictation: Dictation
  // The chat the composer writes in, which dictation started here belongs
  // to.
  chatId: string
  input: string
  setInput: (value: string) => void
  composer: RefObject<ComposerHandle | null>
  // How long a recording runs before it is sent to be transcribed, once the
  // session has said.
  segmentSeconds: number | undefined
  // Whether a recording is kept on the device until its text arrives.
  persist: boolean
  // The microphone could not be opened.
  onError: (cause: unknown) => void
}) {
  const state = useSyncExternalStore(
    dictation.subscribe,
    dictation.getSnapshot,
    dictation.getServerSnapshot,
  )
  const isRecording = state.status === 'recording'
  const isTranscribing = state.status === 'transcribing'
  // The draft as dictated text is added to it, which can happen more than
  // once before the composer renders again.
  const draftRef = useRef(input)
  useEffect(() => {
    draftRef.current = input
  }, [input])

  // Leaving the composer or its chat closes the microphone if it opened it,
  // as another composer can stay mounted while hidden; what was recorded is
  // still transcribed and waits for the chat it was dictated in.
  const [owner] = useState(() => Symbol('dictation'))
  useEffect(() => () => dictation.stop(owner), [dictation, owner, chatId])

  // The chat's dictated text joins the end of the draft as each recording is
  // transcribed.
  useEffect(
    () =>
      dictation.listen(chatId, (text) => {
        const draft = draftRef.current.trim()
        const next = draft ? `${draft} ${text}` : text
        draftRef.current = next
        setInput(next)
        if (dictation.getSnapshot().status === 'recording') return
        // Focus the textarea so the user can edit or send the transcription,
        // then explicitly resize after React commits the new value to the DOM.
        // The layout effect should handle this, but mobile Safari can report
        // stale scrollHeight for programmatic value changes.
        composer.current?.focus()
        requestAnimationFrame(() => {
          composer.current?.resize()
        })
      }),
    [dictation, chatId, setInput, composer],
  )

  const start = useCallback(async () => {
    if (segmentSeconds === undefined) return
    try {
      await dictation.start({ owner, chatId, segmentSeconds, persist })
    } catch (cause) {
      onError(cause)
    }
  }, [dictation, owner, chatId, segmentSeconds, persist, onError])
  const stop = useCallback(() => dictation.stop(), [dictation])

  return {
    state,
    isRecording,
    isTranscribing,
    // What the composer announces of it.
    announcement: isTranscribing
      ? 'Transcribing audio'
      : isRecording
        ? 'Recording audio'
        : '',
    start,
    stop,
  }
}
