import { logError } from '@tinfoil/chat-client/logging'
import { useEffect, useState } from 'react'

// Chrome asks for the microphone on a page in a tab, never in a side panel,
// so the settings page is where the extension is given it.
export const MICROPHONE_SETTINGS_URL = chrome.runtime.getURL(
  'options.html#permissions',
)

const MICROPHONE = { name: 'microphone' as PermissionName }

// Whether the extension may open the microphone: granted, still to be
// asked, or refused.
export const microphonePermission = async () =>
  (await navigator.permissions.query(MICROPHONE)).state

// The same, kept current as the user answers Chrome or changes its settings.
// It has no value until Chrome has said.
export function useMicrophonePermission(): PermissionState | undefined {
  const [state, setState] = useState<PermissionState>()
  useEffect(() => {
    let current = true
    let status: PermissionStatus | undefined
    const changed = () => {
      if (current && status) setState(status.state)
    }
    navigator.permissions.query(MICROPHONE).then(
      (answer) => {
        if (!current) return
        status = answer
        status.addEventListener('change', changed)
        changed()
      },
      (cause) => logError('Unable to read microphone permission', cause),
    )
    return () => {
      current = false
      status?.removeEventListener('change', changed)
    }
  }, [])
  return state
}

// Has Chrome ask for the microphone, which it remembers for the extension.
export async function requestMicrophone(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  stream.getTracks().forEach((track) => track.stop())
}
