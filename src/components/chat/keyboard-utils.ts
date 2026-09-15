import type { KeyboardEvent } from 'react'

// Legacy keyCode reported while an IME is processing a key. Some Safari
// builds fire the conversion-confirming Enter keydown after compositionend
// with isComposing already false, but still report keyCode 229.
const IME_PROCESS_KEY_CODE = 229

/**
 * True when a keydown originates from an IME composition (e.g. confirming a
 * Japanese/Chinese/Korean conversion with Enter). Such events must not
 * trigger actions like submitting a message.
 */
export function isImeComposition(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === IME_PROCESS_KEY_CODE
}
