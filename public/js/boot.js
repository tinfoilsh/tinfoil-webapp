// Runs before first paint (loaded synchronously from <head>). Kept as a
// file rather than inline so the page needs no 'unsafe-inline' or hashes
// in script-src; WEBCAT verifies it like any other asset.

try {
  ;(function () {
    var themeMode =
      localStorage.getItem('tinfoil-settings-theme-mode') ||
      localStorage.getItem('themeMode')
    var theme

    // If no themeMode, check 'tinfoil-settings-theme' / pre-migration 'theme' key
    if (!themeMode) {
      var legacyTheme =
        localStorage.getItem('tinfoil-settings-theme') ||
        localStorage.getItem('theme')
      if (legacyTheme === 'dark' || legacyTheme === 'light') {
        themeMode = legacyTheme
      }
    }

    if (themeMode === 'system' || !themeMode) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    } else {
      theme = themeMode
    }

    document.documentElement.setAttribute('data-theme', theme)
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  })()
} catch (_) {}

try {
  ;(function () {
    try {
      var font =
        localStorage.getItem('tinfoil-settings-chat-font') ||
        localStorage.getItem('chatFont')
      if (font === 'serif' || font === 'mono' || font === 'dyslexic') {
        document.documentElement.setAttribute('data-chat-font', font)
      }
    } catch (_) {}
  })()
} catch (_) {}

try {
  ;(function () {
    try {
      var h =
        (window.visualViewport && window.visualViewport.height) ||
        window.innerHeight ||
        document.documentElement.clientHeight
      if (h) {
        document.documentElement.style.setProperty(
          '--app-height',
          Math.round(h) + 'px',
        )
      }
    } catch (_) {}
  })()
} catch (_) {}
