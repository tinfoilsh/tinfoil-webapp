import { useEffect, useState } from 'react'

export function TextureGrid({ className = '' }: { className?: string }) {
  const [isDarkMode, setIsDarkMode] = useState(false)

  useEffect(() => {
    const checkDarkMode = () => {
      // Check the data-theme attribute which is the source of truth
      const dataTheme = document.documentElement.getAttribute('data-theme')
      setIsDarkMode(dataTheme === 'dark')
    }

    checkDarkMode()

    // Listen for theme changes
    const handleThemeChange = () => checkDarkMode()
    window.addEventListener('themeChanged', handleThemeChange)

    // Also observe the data-theme attribute for changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'data-theme') {
          checkDarkMode()
        }
      })
    })
    observer.observe(document.documentElement, { attributes: true })

    return () => {
      window.removeEventListener('themeChanged', handleThemeChange)
      observer.disconnect()
    }
  }, [])

  const size = 16
  const strokeColor = isDarkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'

  const svgPattern = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <path d="M ${size} 0 L 0 0 0 ${size}" fill="none" stroke="${strokeColor}" stroke-width="1" />
  </svg>`
  const encodedSvg = `data:image/svg+xml,${encodeURIComponent(svgPattern)}`

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-0 ${className}`}
      style={{
        backgroundImage: `url("${encodedSvg}")`,
        backgroundRepeat: 'repeat',
      }}
    />
  )
}
