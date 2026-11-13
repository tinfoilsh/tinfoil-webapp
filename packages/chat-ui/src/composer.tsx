import {
  TfArrowUpAnimated,
  TfStopAnimated,
} from '@tinfoilsh/tinfoil-icons/animated'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import {
  isImeComposition,
  isMobileDevice,
  isSubmitShortcut,
} from './keyboard-utils'
import { cn } from './utils'

export const AI_DISCLAIMER =
  'AI can make mistakes. Verify important information.'

// What an empty composer says, before and during a conversation.
const INPUT_PLACEHOLDER = 'How can I help you today?'
const REPLY_PLACEHOLDER = 'Reply to Al...'

// Maximum height of the composer's textarea before it scrolls internally
const INPUT_MAX_HEIGHT_PX = 240
// Fallback estimate of the input card chrome height (paddings, toolbar row,
// send button) used when the input area wrapper cannot be measured
const INPUT_VIEWPORT_RESERVED_PX = 160
// Minimum breathing room kept above the input area within the visual
// viewport so it never covers the entire screen above the keyboard
const INPUT_VIEWPORT_TOP_GAP_PX = 24

// Wrapper the chat layout puts around the whole bottom input area, including
// banners rendered outside this component.
const INPUT_AREA_SELECTOR = '[data-chat-input-area]'

// Tracks every mounted textarea per shared external ref so an unmounting
// instance can hand the shared ref over to a surviving instance.
const sharedTextareaRegistries = new WeakMap<object, Set<HTMLTextAreaElement>>()

function getSharedTextareaRegistry(ref: object): Set<HTMLTextAreaElement> {
  let registry = sharedTextareaRegistries.get(ref)
  if (!registry) {
    registry = new Set()
    sharedTextareaRegistries.set(ref, registry)
  }
  return registry
}

// Sends the composer's draft, or stops the reply under way.
export function SendButton({
  stop,
  className,
  ...props
}: { stop: boolean } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'aria-label' | 'children'
>) {
  const Icon = stop ? TfStopAnimated : TfArrowUpAnimated
  return (
    <button
      id="send-button"
      type="button"
      className={cn(
        'group flex h-10 w-10 items-center justify-center rounded-site-control bg-tinfoil-oak text-brand-dark transition-colors hover:bg-tinfoil-oak-hover disabled:opacity-50 md:h-8 md:w-8',
        className,
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      aria-label={stop ? 'Stop generation' : 'Send'}
      {...props}
    >
      <Icon
        className="h-6 w-6 text-current transition-colors md:h-5 md:w-5"
        aria-hidden="true"
      />
    </button>
  )
}

// What a composer's owner does to this instance's own textarea.
export type ComposerHandle = {
  focus: () => void
  resize: () => void
}

export type ComposerProps = {
  ref?: Ref<ComposerHandle>
  input: string
  setInput: (value: string) => void
  onSubmit: (e: FormEvent) => void
  // Whether a reply is under way, which the send button stops while the
  // draft has nothing to send.
  busy: boolean
  onCancel: () => void
  // Escape in the textarea stops the reply under way.
  cancelOnEscape?: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
  onFocus?: () => void
  inputMinHeight: string
  // Once a conversation is underway the composer collapses into a single row
  // with the controls flanking the textarea; before it the composer keeps the
  // taller two-row layout.
  hasMessages?: boolean
  enterToNewline?: boolean
  // Edits the draft as a list on a key press, and says whether it did.
  onListKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  // The draft has something to send besides its text.
  hasAttachedContent?: boolean
  // The draft cannot be typed in or sent, as while dictation fills it.
  locked?: boolean
  // The textarea stays mounted but out of sight, as behind what shows below
  // it.
  textareaHidden?: boolean
  belowTextarea?: ReactNode
  dashed?: boolean
  modelSelectorButton?: ReactNode
  // Shown above the card.
  header?: ReactNode
  // Tabs attached to the card's top edge.
  tabs?: ReactNode
  // What the draft holds besides its text, above the textarea.
  attachments?: ReactNode
  // Announced to assistive technology from the toolbar.
  status?: string
  // Controls before the textarea's text, and between the model selector and
  // the send button.
  leadingControls?: ReactNode
  trailingControls?: ReactNode
  // Shown beside the model selector: in the card before a conversation
  // starts, and below it afterwards.
  cardUsage?: ReactNode
  footerUsage?: ReactNode
}

export function Composer({
  ref,
  input,
  setInput,
  onSubmit,
  busy,
  onCancel,
  cancelOnEscape = false,
  inputRef,
  onFocus,
  inputMinHeight,
  hasMessages,
  enterToNewline = false,
  onListKeyDown,
  onPaste,
  hasAttachedContent = false,
  locked = false,
  textareaHidden = false,
  belowTextarea,
  dashed,
  modelSelectorButton,
  header,
  tabs,
  attachments,
  status,
  leadingControls,
  trailingControls,
  cardUsage,
  footerUsage,
}: ComposerProps) {
  const [textareaResetNonce, setTextareaResetNonce] = useState(0)
  const prevInputValueRef = useRef(input)
  const shouldRemountOnClearRef = useRef(false)
  const hasInitiallyFocusedRef = useRef(false)
  const refocusAfterResetRef = useRef(false)

  // Several composers can be mounted at once (e.g. the centered
  // welcome-screen input and the bottom input) while sharing one external
  // `inputRef`, so the shared ref may point at another instance's textarea.
  // Keep a private ref to this instance's own element and use it for all
  // local reads and writes (resize, focus, blur).
  const ownTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const attachTextareaRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      const registered = getSharedTextareaRegistry(inputRef)
      if (el) {
        ownTextareaRef.current = el
        registered.add(el)
        ;(
          inputRef as React.MutableRefObject<HTMLTextAreaElement | null>
        ).current = el
      } else {
        if (ownTextareaRef.current) {
          registered.delete(ownTextareaRef.current)
        }
        if (inputRef.current === ownTextareaRef.current) {
          // Hand the shared ref back to another still-mounted instance (e.g.
          // the welcome-screen input after the bottom input unmounts) so
          // focus actions keep working.
          const remaining = [...registered].pop() ?? null
          ;(
            inputRef as React.MutableRefObject<HTMLTextAreaElement | null>
          ).current = remaining
        }
        ownTextareaRef.current = null
      }
    },
    [inputRef],
  )

  const useIsomorphicLayoutEffect =
    typeof window !== 'undefined' ? useLayoutEffect : useEffect

  const resizeTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return

      const min = Number.parseInt(inputMinHeight, 10) || 0
      // Cap the textarea to the visual viewport (which shrinks when the
      // on-screen keyboard opens) so the toolbar row with the send button
      // always stays visible below it. Measure everything else rendered in
      // the input area (toolbar, paddings, suggestion chips, banners,
      // attachment previews) so the cap adapts to what is actually shown,
      // e.g. the extra suggestions row on the initial query screen.
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const inputArea = el.closest(INPUT_AREA_SELECTOR)
      const chromeHeight = inputArea
        ? inputArea.getBoundingClientRect().height -
          el.getBoundingClientRect().height
        : INPUT_VIEWPORT_RESERVED_PX
      const available = Math.min(
        INPUT_MAX_HEIGHT_PX,
        viewportHeight - chromeHeight - INPUT_VIEWPORT_TOP_GAP_PX,
      )
      // Snap the cap to a whole number of text lines so scrolled-out content
      // is clipped flush at a line boundary instead of mid-line.
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight)
      const max =
        Number.isFinite(lineHeight) && lineHeight > 0
          ? Math.max(Math.floor(available / lineHeight), 1) * lineHeight
          : available

      // Reset to 0 so the browser recomputes content height.
      // Using '0' instead of 'auto' forces scrollHeight to reflect the
      // full content height on mobile Safari, even when the textarea is
      // unfocused (e.g. after programmatic value changes like transcription).
      el.style.height = '0'

      const raw = el.scrollHeight
      const next = Math.max(min, Math.min(raw, max))
      el.style.height = `${next}px`
      el.style.overflowY = raw > max ? 'auto' : 'hidden'

      // Once capped, a line typed at the end lands below the visible area,
      // and browsers do not reliably scroll to it after the height changes
      // above, so keep the caret's line in view.
      if (
        raw > max &&
        document.activeElement === el &&
        el.selectionEnd === el.value.length
      ) {
        el.scrollTop = el.scrollHeight
      }
    },
    [inputMinHeight],
  )

  // Coalesce resize requests to at most one layout read/write per frame.
  // Typing fires several resize triggers per keystroke (input event, value
  // change, viewport changes); collapsing them into a single rAF avoids the
  // repeated forced reflows that dominated the typing CPU profile.
  const resizeRafRef = useRef<number | null>(null)
  const pendingResizeElRef = useRef<HTMLTextAreaElement | null>(null)
  const scheduleResize = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return
      pendingResizeElRef.current = el
      if (resizeRafRef.current !== null) return
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null
        resizeTextarea(pendingResizeElRef.current)
      })
    },
    [resizeTextarea],
  )

  useEffect(() => {
    return () => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current)
        // Clear the id so a later remount (e.g. React Strict Mode's
        // simulated unmount/remount) can schedule again instead of seeing a
        // stale, already-cancelled frame and short-circuiting forever.
        resizeRafRef.current = null
      }
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => ownTextareaRef.current?.focus(),
      resize: () => resizeTextarea(ownTextareaRef.current),
    }),
    [resizeTextarea],
  )

  // If the input transitions from non-empty -> empty (send/clear), remount the
  // textarea to guarantee any stuck inline height is dropped on mobile Safari.
  useEffect(() => {
    const prev = prevInputValueRef.current
    if (prev !== '' && input === '' && shouldRemountOnClearRef.current) {
      refocusAfterResetRef.current =
        typeof document !== 'undefined' &&
        ownTextareaRef.current !== null &&
        document.activeElement === ownTextareaRef.current
      setTextareaResetNonce((n) => n + 1)
    }
    prevInputValueRef.current = input
    if (input === '') {
      shouldRemountOnClearRef.current = false
    }
  }, [input])

  useEffect(() => {
    if (refocusAfterResetRef.current && ownTextareaRef.current) {
      ownTextareaRef.current.focus()
      refocusAfterResetRef.current = false
    }
  }, [textareaResetNonce])

  // Auto-resize textarea as content changes (typing, transcription, paste, etc.)
  // Layout effect avoids iOS Safari cases where `scrollHeight` lags a paint.
  useIsomorphicLayoutEffect(() => {
    // Synchronous pass before paint avoids a visible height jump.
    resizeTextarea(ownTextareaRef.current)

    // iOS Safari can report the previous scrollHeight on the same tick; re-check
    // on the next frame (coalesced with any other pending resize) to ensure
    // growth kicks in.
    scheduleResize(ownTextareaRef.current)
    // Include `textareaResetNonce` so a remount recalculates height immediately.
    // Include `locked` and `textareaHidden` because a hidden textarea
    // measures as zero height, so it must be re-measured once it reappears.
  }, [
    input,
    resizeTextarea,
    scheduleResize,
    textareaResetNonce,
    locked,
    textareaHidden,
  ])

  // Recompute the height cap when the visual viewport changes (e.g. the
  // on-screen keyboard opens or closes) so long text never pushes the send
  // button out of view.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const onViewportResize = () => scheduleResize(ownTextareaRef.current)
    vv.addEventListener('resize', onViewportResize)
    return () => vv.removeEventListener('resize', onViewportResize)
  }, [scheduleResize])

  // Recompute the height cap when anything else in the input area changes
  // size (attachments, their upload status, banners), not only on the next
  // keystroke. The textarea's own resizes also land here, but they settle
  // after one pass because the cap does not depend on the textarea height.
  useEffect(() => {
    const inputArea = ownTextareaRef.current?.closest(INPUT_AREA_SELECTOR)
    if (!inputArea || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() =>
      scheduleResize(ownTextareaRef.current),
    )
    observer.observe(inputArea)
    return () => observer.disconnect()
  }, [scheduleResize])

  // Focus textarea on initial mount only (not on remounts after sending)
  useEffect(() => {
    if (!hasInitiallyFocusedRef.current && ownTextareaRef.current) {
      ownTextareaRef.current.focus()
      hasInitiallyFocusedRef.current = true
    }
  }, [])

  const isCompact = Boolean(hasMessages)
  const hasSubmittableContent = Boolean(input.trim()) || hasAttachedContent
  const showStopAction = busy && !hasSubmittableContent
  const hasFooterControls = Boolean(footerUsage || modelSelectorButton)

  return (
    <div className="flex flex-col gap-2">
      {hasMessages && modelSelectorButton && (
        <div className="flex items-center self-end px-3 md:hidden">
          {modelSelectorButton}
        </div>
      )}
      <div className="relative">
        {header}
        <div
          className={cn(
            // relative anchors the folder-style tabs below to the card itself.
            'relative rounded-3xl border bg-white px-3 py-3 shadow-md transition-colors dark:bg-surface-chat md:rounded-4xl md:px-6 md:py-4',
            isCompact && 'md:px-4 md:py-3',
            dashed
              ? 'border-dashed border-content-muted'
              : 'border-border-subtle',
          )}
        >
          {tabs}
          {attachments}

          {/* In compact mode the toolbar below uses display: contents so its
              button groups become flex siblings of the textarea and can be
              ordered around it. */}
          <div className={cn(isCompact && 'flex items-end gap-2')}>
            {/* The button groups are sized to the send button so a one-line
                textarea centers against them; when it grows they stay pinned
                to the bottom via items-end. */}
            {/* A hidden textarea stays mounted (so its ref, height and focus
                handling survive) behind what shows below it, which occupies
                the same slot. */}
            <div
              className={cn(
                'flex w-full min-w-0 flex-col',
                isCompact && 'flex-1 self-center',
              )}
            >
              <textarea
                id="chat-input"
                aria-label="Message"
                ref={attachTextareaRef}
                key={textareaResetNonce}
                value={input}
                readOnly={locked}
                onFocus={onFocus}
                onChange={(e) => {
                  // Resize is driven by the layout effect on the resulting value
                  // change; avoid an extra synchronous reflow here.
                  setInput(e.target.value)
                }}
                onInput={(e) => {
                  // Some mobile Safari builds update `scrollHeight` more reliably on
                  // `input`; schedule a coalesced resize rather than reflowing now.
                  scheduleResize(e.currentTarget as HTMLTextAreaElement)
                }}
                onPaste={locked ? undefined : onPaste}
                onKeyDown={(e) => {
                  if (locked && e.key !== 'Escape') {
                    return
                  }
                  // Enter during IME composition only confirms the conversion;
                  // it must not send the message or edit the list structure.
                  if (e.key === 'Enter' && isImeComposition(e)) {
                    return
                  }
                  if (isSubmitShortcut(e, enterToNewline)) {
                    e.preventDefault()
                    if (hasSubmittableContent) {
                      shouldRemountOnClearRef.current = true
                      onSubmit(e)
                    }
                  } else if (onListKeyDown?.(e)) {
                    return
                  } else if (e.key === 'Escape' && cancelOnEscape) {
                    e.preventDefault()
                    onCancel()
                  }
                }}
                placeholder={
                  hasMessages ? REPLY_PLACEHOLDER : INPUT_PLACEHOLDER
                }
                rows={1}
                className={cn(
                  'w-full resize-none bg-transparent font-chat text-lg leading-relaxed text-content-primary placeholder:text-content-muted focus:outline-none',
                  textareaHidden && 'hidden',
                )}
                style={{
                  minHeight: inputMinHeight,
                  maxHeight: `${INPUT_MAX_HEIGHT_PX}px`,
                }}
              />
              {belowTextarea}
            </div>

            <div
              className={cn(
                isCompact
                  ? 'contents'
                  : 'mt-3 flex items-center justify-between',
              )}
            >
              {status !== undefined && (
                <span className="sr-only" role="status" aria-live="polite">
                  {status}
                </span>
              )}
              <div
                className={cn(
                  'flex items-center gap-1',
                  isCompact && 'order-first h-10 md:h-8',
                )}
              >
                {leadingControls}
              </div>

              <div
                className={cn(
                  'flex items-center gap-2',
                  isCompact && 'h-10 md:h-8',
                )}
              >
                {/* Once a conversation is underway these move to the footer
                  below the card so the card itself stays focused on composing. */}
                {!hasMessages && cardUsage}
                {!hasMessages && modelSelectorButton && (
                  <div>{modelSelectorButton}</div>
                )}
                {trailingControls}
                <SendButton
                  stop={showStopAction}
                  onClick={(e) => {
                    if (showStopAction) {
                      e.preventDefault()
                      onCancel()
                    } else {
                      shouldRemountOnClearRef.current = true
                      onSubmit(e)
                      // On iOS Safari, forcing blur here can lead to a "dead" touch region
                      // after the keyboard dismisses. Keep focus on mobile; desktop can blur.
                      if (!isMobileDevice()) {
                        ownTextareaRef.current?.blur()
                      }
                    }
                  }}
                  className={cn(!isCompact && 'ml-2')}
                  disabled={
                    showStopAction ? false : locked || !hasSubmittableContent
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {hasMessages && (
        <div className="flex items-center justify-between gap-4 px-3 md:px-6">
          {/* A composer given no footer controls centers the disclaimer. */}
          <p
            className={cn(
              'text-xs text-content-muted',
              !hasFooterControls && 'flex-1 text-balance text-center',
            )}
          >
            {AI_DISCLAIMER}
          </p>
          {hasFooterControls && (
            <div className="hidden items-center gap-2 md:flex">
              {footerUsage}
              {modelSelectorButton}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
