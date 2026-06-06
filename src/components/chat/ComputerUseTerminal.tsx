/**
 * Optional terminal at the bottom of the live computer-use card. Hidden by
 * default — the operator opens it from the terminal toggle in the toolbar.
 *
 * The terminal is the operator's own surface. It does NOT mirror the
 * agent's exec stream (that's surfaced in the Agent activity popover);
 * the operator can type commands here and they run as `exec` against the
 * same session, just like the agent's actions do.
 */

'use client'

import { type LoopEvent } from '@/services/computer-use'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

export interface ComputerUseTerminalHandle {
  /**
   * Hand a LoopEvent to the terminal. The terminal currently ignores every
   * event — agent activity lives in the popover, not here — but the method
   * is kept so the session-thread plumbing stays stable if we ever decide
   * to surface a specific subset (e.g. exec-init prompts).
   */
  appendEvent(event: LoopEvent): void
  /** Wipe the buffer (e.g. on session reset). */
  reset(): void
}

interface ComputerUseTerminalProps {
  onExec: (cmd: string) => Promise<string>
  /**
   * Fires once the WASM is initialised + the terminal is open on the DOM.
   * The parent uses this to flush any frames that arrived before the
   * terminal mounted (e.g. when the user opens the terminal mid-run).
   */
  onReady?: () => void
  className?: string
}

let ghosttyInitPromise: Promise<void> | null = null
async function ensureGhosttyInitialized() {
  if (!ghosttyInitPromise) {
    const mod = await import('ghostty-web')
    ghosttyInitPromise = mod.init()
  }
  return ghosttyInitPromise
}

const PROMPT = '\x1b[1;36m$\x1b[0m '

const STYLE = {
  reset: '\x1b[0m',
  agent: '\x1b[2;37m',
  exec: '\x1b[36m',
  err: '\x1b[91m',
  user: '\x1b[1;36m',
}

interface InternalTerm {
  write: (s: string) => void
  dispose: () => void
}

// Patch ghostty's hidden input textarea so the browser doesn't scroll the
// containing page when it receives focus. ghostty positions the textarea
// at (0,0) of the terminal container with a 50% inset clip-path — Chrome
// treats it as off-screen and scrollIntoView's it on focus, which yanks
// the page up to the top of the computer-use card. preventScroll on the
// focus call defeats that.
function pinFocusNoScroll(ta: HTMLTextAreaElement | undefined) {
  if (!ta) return
  const original = ta.focus.bind(ta)
  ta.focus = (opts?: FocusOptions) => original({ ...opts, preventScroll: true })
  // Belt + suspenders: ignore any subsequent scrollIntoView the browser
  // (or library code) triggers on this element.
  const noopScroll = () => {}
  Object.defineProperty(ta, 'scrollIntoView', {
    configurable: true,
    value: noopScroll,
  })
}

export const ComputerUseTerminal = forwardRef<
  ComputerUseTerminalHandle,
  ComputerUseTerminalProps
>(function ComputerUseTerminal({ onExec, onReady, className }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<InternalTerm | null>(null)
  const lineBufRef = useRef('')
  const execBusyRef = useRef(false)
  const onExecRef = useRef(onExec)
  const onReadyRef = useRef(onReady)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    onExecRef.current = onExec
  }, [onExec])
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | undefined
    ;(async () => {
      const mod = await import('ghostty-web')
      await ensureGhosttyInitialized()
      if (cancelled || !containerRef.current) return
      const term = new mod.Terminal({
        cols: 100,
        rows: 14,
        fontSize: 12,
        theme: { background: '#0b0e15', foreground: '#d8e0f0' },
      })
      term.open(containerRef.current)
      pinFocusNoScroll(term.textarea)
      const dataSub = term.onData((data: string) => {
        for (let i = 0; i < data.length; i++) {
          const ch = data[i]
          if (ch === '\r') {
            if (execBusyRef.current) continue
            const cmd = lineBufRef.current
            lineBufRef.current = ''
            term.write('\r\n')
            if (!cmd.trim()) {
              term.write(PROMPT)
              continue
            }
            execBusyRef.current = true
            ;(async () => {
              try {
                const output = await onExecRef.current(cmd)
                writeStreamed(term, output)
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                term.write(`${STYLE.err}${msg}${STYLE.reset}\r\n`)
              } finally {
                execBusyRef.current = false
                term.write(PROMPT + lineBufRef.current)
              }
            })()
            continue
          }
          if (ch === '\x7f') {
            if (lineBufRef.current.length > 0) {
              lineBufRef.current = lineBufRef.current.slice(0, -1)
              term.write('\b \b')
            }
            continue
          }
          if (ch === '\x03') {
            lineBufRef.current = ''
            term.write(`${STYLE.err}^C${STYLE.reset}\r\n${PROMPT}`)
            continue
          }
          if (ch >= ' ' && ch !== '\x7f') {
            lineBufRef.current += ch
            term.write(ch)
          }
        }
      })
      term.write(PROMPT)
      termRef.current = {
        write: (s: string) => term.write(s),
        dispose: () => {
          dataSub.dispose()
          term.dispose()
        },
      }
      setReady(true)
      onReadyRef.current?.()
      cleanup = () => termRef.current?.dispose()
    })().catch((err) => {
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
        const p = document.createElement('p')
        p.textContent = `Terminal failed to load: ${err instanceof Error ? err.message : String(err)}`
        p.className = 'text-xs text-red-500 p-2'
        containerRef.current.appendChild(p)
      }
    })
    return () => {
      cancelled = true
      cleanup?.()
      termRef.current = null
    }
  }, [])

  useImperativeHandle(ref, () => ({
    appendEvent(_event: LoopEvent) {
      // No-op: the terminal is the user's own surface and ignores agent
      // events. Kept on the handle so the session-thread plumbing stays
      // stable across any future change of policy.
    },
    reset() {
      const term = termRef.current
      if (!term) return
      term.write('\x1b[2J\x1b[H')
      lineBufRef.current = ''
      term.write(PROMPT)
    },
  }))

  return (
    <div className="rounded-lg border border-border-subtle bg-[#0b0e15]">
      <div
        ref={containerRef}
        className={
          className ??
          'h-56 w-full overflow-hidden rounded-lg px-2 py-1 text-xs'
        }
        aria-label="Session terminal"
      />
      {!ready && (
        <p className="px-2 pb-1 text-[10px] text-content-muted">
          Loading terminal…
        </p>
      )}
    </div>
  )
})

function writeStreamed(
  term: { write: (s: string) => void },
  text: string,
): void {
  if (!text) return
  const normalised = text.endsWith('\n') ? text : text + '\n'
  term.write(normalised.replace(/\n/g, '\r\n'))
}
