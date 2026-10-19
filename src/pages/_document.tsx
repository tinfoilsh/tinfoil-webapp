import { Head, Html, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en" data-theme="light" className="overflow-x-hidden">
      <Head>
        {/* Theme, chat font and --app-height must apply before first paint, so
            this is a plain parser-blocking script (beforeInteractive would defer
            it); see public/js/boot.js. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/js/boot.js" />
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
          name="keywords"
          content="AI chat, private AI, privacy, confidential computing, open source, secure AI, private chat"
        />
        <meta name="author" content="Tinfoil" />
        <meta property="og:locale" content="en_US" />
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
      </Head>
      <body className="font-aeonik-fono antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
