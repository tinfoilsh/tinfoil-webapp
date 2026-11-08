import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { isImeComposition } from '../keyboard-utils'

const LIST_INDENT = '    '
const BULLET_PREFIX = '  \u2022  '
const LIST_PREFIX = /^([ \t]*)([•*+-]|\d+\.)([ \t]+)/

export function useListEditing(
  value: string,
  onChange: (value: string) => void,
) {
  const pendingSelection = useRef<{
    textarea: HTMLTextAreaElement
    value: string
    position: number
  } | null>(null)

  // Restore the caret after React commits the controlled textarea's value.
  useLayoutEffect(() => {
    const pending = pendingSelection.current
    pendingSelection.current = null
    if (!pending || pending.value !== value || !pending.textarea.isConnected) {
      return
    }
    pending.textarea.setSelectionRange(pending.position, pending.position)
    if (pending.position === value.length) {
      pending.textarea.scrollTop = pending.textarea.scrollHeight
    }
  }, [value])

  return (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isImeComposition(event) ||
      ![' ', 'Tab', 'Enter'].includes(event.key)
    ) {
      return false
    }

    const textarea = event.currentTarget
    const cursor = textarea.selectionStart
    if (cursor !== textarea.selectionEnd) return false
    const before = value.slice(0, cursor)
    const after = value.slice(cursor)
    const lineStart = before.lastIndexOf('\n') + 1
    const line = before.slice(lineStart)

    const applyEdit = (nextValue: string, position: number) => {
      event.preventDefault()
      pendingSelection.current = { textarea, value: nextValue, position }
      onChange(nextValue)
      return true
    }

    if (event.key === ' ') {
      const match = line.match(/^([ \t]*)([-*+]|\d+\.)$/)
      if (!match) return false
      const [, indent, marker] = match
      const prefix = indent + (/\d/.test(marker) ? `${marker} ` : BULLET_PREFIX)
      return applyEdit(
        value.slice(0, lineStart) + prefix + after,
        lineStart + prefix.length,
      )
    }

    const match = line.match(LIST_PREFIX)
    if (!match) return false
    const [prefix, indent, marker, spacing] = match
    const lineEnd = value.indexOf('\n', cursor)
    const content = value.slice(
      lineStart + prefix.length,
      lineEnd === -1 ? value.length : lineEnd,
    )

    if (event.key === 'Tab') {
      if (/^\[[ x]\]/.test(content)) return false
      if (!event.shiftKey) {
        return applyEdit(
          value.slice(0, lineStart) + LIST_INDENT + line + after,
          cursor + LIST_INDENT.length,
        )
      }
      const removedLength = line.startsWith(LIST_INDENT)
        ? LIST_INDENT.length
        : prefix.length
      return applyEdit(
        value.slice(0, lineStart) + line.slice(removedLength) + after,
        cursor - removedLength,
      )
    }

    if (!content.trim()) {
      return applyEdit(
        value.slice(0, lineStart) + indent + after,
        lineStart + indent.length,
      )
    }
    const nextMarker = /^\d+\.$/.test(marker)
      ? `${Number.parseInt(marker, 10) + 1}.`
      : marker
    const continuation = '\n' + indent + nextMarker + spacing
    return applyEdit(
      before + continuation + after,
      cursor + continuation.length,
    )
  }
}
