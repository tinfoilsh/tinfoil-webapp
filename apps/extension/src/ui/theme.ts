import { useLayoutEffect, useSyncExternalStore } from 'react'

const DARK_SCHEME = '(prefers-color-scheme: dark)'

function subscribe(changed: () => void) {
  const media = matchMedia(DARK_SCHEME)
  media.addEventListener('change', changed)
  return () => media.removeEventListener('change', changed)
}

// Whether the browser's color scheme is dark, which the page follows. The
// theme is named on the document both ways the web app's styles and
// components read it.
export function useDarkMode(): boolean {
  const dark = useSyncExternalStore(
    subscribe,
    () => matchMedia(DARK_SCHEME).matches,
  )
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  return dark
}
