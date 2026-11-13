/**
 * Resolve the Web Audio constructor, falling back to the prefixed name older
 * Safari builds expose. Returns null during SSR or when Web Audio is missing.
 */
export function getAudioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  )
}
