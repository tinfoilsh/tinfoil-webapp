import type { KeyboardEvent } from 'react'

// Legacy keyCode reported while an IME is processing a key. Some Safari
// builds fire the conversion-confirming Enter keydown after compositionend
// with isComposing already false, but still report keyCode 229.
const IME_PROCESS_KEY_CODE = 229

// iPadOS Safari reports a desktop user agent, so it does not match.
const MOBILE_USER_AGENT_PATTERN = /iPhone|iPad|iPod|Android/i

/**
 * True on phones and other devices that report a mobile user agent. Their
 * on-screen keyboards have no Shift+Enter, so Enter is the only way to type a
 * new line.
 */
export function isMobileDevice(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    MOBILE_USER_AGENT_PATTERN.test(navigator.userAgent)
  )
}

/**
 * True when a keydown originates from an IME composition (e.g. confirming a
 * Japanese/Chinese/Korean conversion with Enter). Such events must not
 * trigger actions like submitting a message.
 */
export function isImeComposition(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === IME_PROCESS_KEY_CODE
}

/**
 * True when an Enter keydown should submit a chat text box. Cmd/Ctrl+Enter
 * always submits; plain Enter submits unless the user chose Enter for new
 * lines or is on a mobile device.
 */
export function isSubmitShortcut(
  e: KeyboardEvent<HTMLElement>,
  enterToNewline: boolean,
): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false
  if (e.metaKey || e.ctrlKey) return true
  return !enterToNewline && !isMobileDevice()
}
