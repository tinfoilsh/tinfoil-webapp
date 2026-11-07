import { SETTINGS_READ_ALOUD_SPEED } from '@/constants/storage-keys'
import { useSyncExternalStore } from 'react'

// The speeds read aloud offers, as multiples of how fast the voice speaks.
// The harness plays the audio at the speed a request names, keeping the
// voice's pitch.
export const READ_ALOUD_SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const
export type ReadAloudSpeed = (typeof READ_ALOUD_SPEEDS)[number]
const VOICE_SPEED: ReadAloudSpeed = 1

const listeners = new Set<() => void>()

// The speed this device reads aloud at.
export function readAloudSpeed(): ReadAloudSpeed {
  try {
    const stored = Number(localStorage.getItem(SETTINGS_READ_ALOUD_SPEED))
    return READ_ALOUD_SPEEDS.find((speed) => speed === stored) ?? VOICE_SPEED
  } catch {
    return VOICE_SPEED
  }
}

export function setReadAloudSpeed(speed: ReadAloudSpeed): void {
  try {
    localStorage.setItem(SETTINGS_READ_ALOUD_SPEED, String(speed))
  } catch {
    // Storage can be blocked; replies then read at the voice's own speed.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_READ_ALOUD_SPEED) listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useReadAloudSpeed(): [
  ReadAloudSpeed,
  (speed: ReadAloudSpeed) => void,
] {
  const speed = useSyncExternalStore(
    subscribe,
    readAloudSpeed,
    () => VOICE_SPEED,
  )
  return [speed, setReadAloudSpeed]
}

// The speed a speech request names, which it leaves out at the voice's own.
export function speechSpeed(): { speed?: ReadAloudSpeed } {
  const speed = readAloudSpeed()
  return speed === VOICE_SPEED ? {} : { speed }
}
