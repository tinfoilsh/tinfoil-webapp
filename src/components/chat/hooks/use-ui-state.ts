import {
  SETTINGS_THEME,
  SETTINGS_THEME_MODE,
  UI_SIDEBAR_OPEN,
} from '@/constants/storage-keys'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

interface UseUIStateReturn {
  isClient: boolean
  isSidebarOpen: boolean
  isDarkMode: boolean
  themeMode: ThemeMode
  windowWidth: number
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>
  toggleTheme: () => void
  setThemeMode: (mode: ThemeMode) => void
  openAndExpandVerifier: () => void
  handleInputFocus: () => void
}

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

export function useUIState(): UseUIStateReturn {
  const [isClient, setIsClient] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem(UI_SIDEBAR_OPEN) === 'true'
    }
    return false
  })
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system')
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 0,
  )

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Client-side initialization
  useEffect(() => {
    setIsClient(true)

    // Check localStorage for theme mode
    const savedThemeMode = localStorage.getItem(
      SETTINGS_THEME_MODE,
    ) as ThemeMode | null
    if (
      savedThemeMode &&
      ['light', 'dark', 'system'].includes(savedThemeMode)
    ) {
      setThemeModeState(savedThemeMode)
      if (savedThemeMode === 'system') {
        const prefersDark = window.matchMedia(
          '(prefers-color-scheme: dark)',
        ).matches
        setIsDarkMode(prefersDark)
      } else {
        setIsDarkMode(savedThemeMode === 'dark')
      }
      return
    }

    // Legacy: check old 'theme' key for backwards compatibility
    const savedTheme =
      localStorage.getItem(SETTINGS_THEME) ?? localStorage.getItem('theme')
    if (savedTheme !== null) {
      const mode = savedTheme === 'dark' ? 'dark' : 'light'
      setThemeModeState(mode)
      setIsDarkMode(savedTheme === 'dark')
      // Migrate to new key
      localStorage.setItem(SETTINGS_THEME_MODE, mode)
      return
    }

    // Default to system preference for new users
    setThemeModeState('system')
    const prefersDark = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches
    setIsDarkMode(prefersDark)
  }, [])

  // Add effect to handle window resizing
  useEffect(() => {
    if (isClient) {
      const handleResize = () => {
        setWindowWidth(window.innerWidth)
      }

      handleResize()
      window.addEventListener('resize', handleResize)
      return () => {
        window.removeEventListener('resize', handleResize)
      }
    }
  }, [isClient])

  // Sync CSS theme tokens with current theme selection
  useIsomorphicLayoutEffect(() => {
    if (!isClient) return

    const theme = isDarkMode ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
    if (isDarkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isClient, isDarkMode])

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (!isClient || themeMode !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches)
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [isClient, themeMode])

  // Add effect to prevent body and html scrolling
  useEffect(() => {
    if (isClient) {
      // Prevent scrolling on both body and html elements
      document.body.style.position = 'fixed'
      document.body.style.width = '100%'
      document.body.style.height = '100%'
      document.body.style.overflow = 'hidden'
      document.body.style.overscrollBehavior = 'none'

      // Also apply to the HTML element
      document.documentElement.style.overscrollBehavior = 'none'
      document.documentElement.style.overflow = 'hidden'
      document.documentElement.style.height = '100%'

      return () => {
        // Cleanup
        document.body.style.position = ''
        document.body.style.width = ''
        document.body.style.height = ''
        document.body.style.overflow = ''
        document.body.style.overscrollBehavior = ''

        document.documentElement.style.overscrollBehavior = ''
        document.documentElement.style.overflow = ''
        document.documentElement.style.height = ''
      }
    }
  }, [isClient])

  // Persist sidebar open state to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(UI_SIDEBAR_OPEN, isSidebarOpen ? 'true' : 'false')
  }, [isSidebarOpen])

  // Set theme mode (light, dark, or system)
  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode)
    localStorage.setItem(SETTINGS_THEME_MODE, mode)

    if (mode === 'system') {
      const prefersDark = window.matchMedia(
        '(prefers-color-scheme: dark)',
      ).matches
      setIsDarkMode(prefersDark)
      // Also update legacy key for backwards compatibility
      localStorage.setItem(SETTINGS_THEME, prefersDark ? 'dark' : 'light')
    } else {
      setIsDarkMode(mode === 'dark')
      localStorage.setItem(SETTINGS_THEME, mode)
    }

    // Trigger theme change event for profile sync
    window.dispatchEvent(
      new CustomEvent('themeChanged', {
        detail: mode,
      }),
    )
  }, [])

  // Toggle dark mode (legacy, toggles between light and dark)
  const toggleTheme = useCallback(() => {
    const newMode = isDarkMode ? 'light' : 'dark'
    setThemeMode(newMode)
  }, [isDarkMode, setThemeMode])

  // Handle verifier expansion
  const openAndExpandVerifier = useCallback(() => {
    // Always ensure the sidebar is open
    setIsSidebarOpen(true)

    // Add a delay to ensure sidebar is opened before expanding verifier
    setTimeout(() => {
      const event = new CustomEvent('expand-verifier')
      window.dispatchEvent(event)
    }, 300)
  }, [])

  // Handle input focus
  const handleInputFocus = useCallback(() => {
    // Only close sidebar on narrow screens (mobile devices)
    if (isSidebarOpen && windowWidth < 768) {
      setIsSidebarOpen(false)
    }
  }, [isSidebarOpen, windowWidth])

  return {
    isClient,
    isSidebarOpen,
    isDarkMode,
    themeMode,
    windowWidth,
    messagesEndRef,
    setIsSidebarOpen,
    toggleTheme,
    setThemeMode,
    openAndExpandVerifier,
    handleInputFocus,
  }
}
