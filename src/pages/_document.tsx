import { Head, Html, Main, NextScript } from 'next/document'
import Script from 'next/script'

export default function Document() {
  // Inline script to set theme before first paint to prevent flash
  const themeScript = `
    (function() {
      var themeMode = localStorage.getItem('tinfoil-settings-theme-mode')
        || localStorage.getItem('themeMode');
      var theme;

      // If no themeMode, check 'tinfoil-settings-theme' / pre-migration 'theme' key
      if (!themeMode) {
        var legacyTheme = localStorage.getItem('tinfoil-settings-theme')
          || localStorage.getItem('theme');
        if (legacyTheme === 'dark' || legacyTheme === 'light') {
          themeMode = legacyTheme;
        }
      }

      if (themeMode === 'system' || !themeMode) {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } else {
        theme = themeMode;
      }

      document.documentElement.setAttribute('data-theme', theme);
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    })();
  `

  // Inline script to set --app-height before first paint, so the bottom-anchored
  // chat input is positioned correctly on every browser, including ones that
  // don't support 100dvh (older Chrome/Firefox/Edge on Android, in-app webviews).
  // Dynamic resize handling is owned by the React effect in use-ui-state /
  // chat-interface so we deliberately don't register listeners here.
  const appHeightScript = `
    (function() {
      try {
        var h = (window.visualViewport && window.visualViewport.height)
          || window.innerHeight
          || document.documentElement.clientHeight;
        if (h) {
          document.documentElement.style.setProperty(
            '--app-height',
            Math.round(h) + 'px'
          );
        }
      } catch (_) {}
    })();
  `

  return (
    <Html lang="en" data-theme="light" className="overflow-x-hidden">
      <Head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: appHeightScript }} />
        <link rel="preconnect" href="https://clerk.accounts.dev" />

        <link rel="manifest" href="/site.webmanifest" />

        <meta
          name="theme-color"
          content="#ffffff"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#121212"
          media="(prefers-color-scheme: dark)"
        />

        <meta
          name="description"
          content="Verifiably Private AI chat application supporting open source models through Tinfoil"
        />
        <meta
          name="keywords"
          content="AI chat, private AI, privacy, confidential computing, open source, secure AI, private chat"
        />
        <meta name="author" content="Tinfoil" />

        <meta property="og:title" content="Tinfoil Private Chat" />
        <meta
          property="og:description"
          content="Private AI chat application supporting open source models through Tinfoil"
        />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="en_US" />

        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Tinfoil Private Chat" />
        <meta
          name="twitter:description"
          content="Private AI chat application supporting open source models through Tinfoil"
        />

        <meta name="robots" content="index, follow" />

        <link
          rel="icon"
          href="/icon-light.png"
          media="(prefers-color-scheme: light)"
          type="image/png"
        />
        <link
          rel="icon"
          href="/icon-dark.png"
          media="(prefers-color-scheme: dark)"
          type="image/png"
        />

        <link
          rel="apple-touch-icon"
          href="/apple-touch-icon-light.png"
          sizes="180x180"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="apple-touch-icon"
          href="/apple-touch-icon-dark.png"
          sizes="180x180"
          media="(prefers-color-scheme: dark)"
        />
        <link
          rel="apple-touch-icon"
          href="/apple-touch-icon.png"
          sizes="180x180"
        />

        <link rel="icon" href="/android-chrome-192x192.png" sizes="192x192" />
        <link rel="icon" href="/android-chrome-512x512.png" sizes="512x512" />

        <Script
          defer
          data-domain="chat.tinfoil.sh"
          data-api="https://plausible.io/api/event"
          src="/js/plausible.js"
          integrity="sha384-2koU+A5hG/EjBLH1x5k5ThN+dPO7wtgAfkwcsSgQq3kNc0ouUd56j17YOJ0aE0yv"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      </Head>
      <body className="font-aeonik-fono antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
