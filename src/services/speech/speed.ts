import { useProfileSetting } from '@/services/harness/provider'
import { getView } from '@/services/harness/runtime'

// The speeds read aloud offers, as multiples of how fast the voice speaks.
// The harness plays the audio at the speed a request names, keeping the
// voice's pitch.
export const READ_ALOUD_SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const
export type ReadAloudSpeed = (typeof READ_ALOUD_SPEEDS)[number]
const VOICE_SPEED: ReadAloudSpeed = 1
const READ_ALOUD_SPEED_FIELD = 'readAloudSpeed'

// A speed the profile holds, or the voice's own for one this client does
// not offer.
function offeredSpeed(value: unknown): ReadAloudSpeed {
  return READ_ALOUD_SPEEDS.find((speed) => speed === value) ?? VOICE_SPEED
}

// The speed the account reads aloud at, kept in its profile.
export function useReadAloudSpeed(): [
  ReadAloudSpeed,
  (speed: ReadAloudSpeed) => void,
] {
  const [speed, setSpeed] = useProfileSetting<unknown>(
    READ_ALOUD_SPEED_FIELD,
    VOICE_SPEED,
  )
  return [offeredSpeed(speed), setSpeed]
}

// The speed a speech request names, which it leaves out at the voice's own.
export function speechSpeed(): { speed?: ReadAloudSpeed } {
  const speed = offeredSpeed(getView().profile[READ_ALOUD_SPEED_FIELD])
  return speed === VOICE_SPEED ? {} : { speed }
}
