import { AuthCleanupHandler } from '@/components/auth-cleanup-handler'
import { AuthTokenSync } from '@/components/auth-token-sync'
import { useChatFontSync } from '@/components/chat/hooks/use-chat-font'
import { SignoutProgressOverlay } from '@/components/signout-progress-overlay'
import '@/styles/globals.css'
import '@/styles/tailwind.css'
import { analyticsExcluded } from '@/utils/analytics-routes'
import { migrateStorageKeys } from '@/utils/storage-migration'
import { Clerk } from '@clerk/clerk-js/no-rhc'
import { ClerkProvider } from '@clerk/react'
import { ui as clerkUi } from '@clerk/ui/no-rhc'
import type { AppProps } from 'next/app'
import dynamic from 'next/dynamic'
import localFont from 'next/font/local'
import Head from 'next/head'
import Script from 'next/script'

const aeonikFono = localFont({
  src: [
    {
      path: '../fonts/aeonikfono-regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../fonts/aeonikfono-medium.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: '../fonts/aeonikfono-bold.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-aeonik-fono',
  // Core UI font: preloaded so text doesn't repaint from the fallback.
  display: 'swap',
  preload: true,
})

const aeonik = localFont({
  src: [
    {
      path: '../fonts/aeonik-regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../fonts/aeonik-regularitalic.woff2',
      weight: '400',
      style: 'italic',
    },
    {
      path: '../fonts/aeonik-semibold.woff2',
      weight: '600',
      style: 'normal',
    },
    {
      path: '../fonts/aeonik-semibolditalic.woff2',
      weight: '600',
      style: 'italic',
    },
    {
      path: '../fonts/aeonik-bold.woff2',
      weight: '700',
      style: 'normal',
    },
    {
      path: '../fonts/aeonik-bolditalic.woff2',
      weight: '700',
      style: 'italic',
    },
  ],
  variable: '--font-aeonik',
  // Core UI font: preloaded so text doesn't repaint from the fallback.
  display: 'swap',
  preload: true,
  declarations: [{ prop: 'ascent-override', value: '90%' }],
})

const lora = localFont({
  src: [
    {
      path: '../fonts/lora-variable.woff2',
      style: 'normal',
    },
    {
      path: '../fonts/lora-variable-italic.woff2',
      style: 'italic',
    },
  ],
  variable: '--font-lora',
  // Preload chat font previews before the settings dialog opens.
  display: 'swap',
  preload: true,
})

const openDyslexic = localFont({
  src: [
    {
      path: '../fonts/OpenDyslexic-Regular.otf',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../fonts/OpenDyslexic-Italic.otf',
      weight: '400',
      style: 'italic',
    },
    {
      path: '../fonts/OpenDyslexic-Bold.otf',
      weight: '700',
      style: 'normal',
    },
    {
      path: '../fonts/OpenDyslexic-BoldItalic.otf',
      weight: '700',
      style: 'italic',
    },
  ],
  variable: '--font-opendyslexic',
  // Preload chat font previews before the settings dialog opens.
  display: 'swap',
  preload: true,
})

migrateStorageKeys()

// Client-only: the toast viewport carries an inline style attribute, which
// the CSP would block in prerendered HTML and React would not reapply.
const Toaster = dynamic(
  () => import('@/components/ui/toaster').then((m) => m.Toaster),
  { ssr: false },
)

export default function App({ Component, pageProps, router }: AppProps) {
  useChatFontSync()

  return (
    <>
      <Head>
        <title key="page-title">Tinfoil Private Chat</title>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
        />
        <meta
          key="description"
          name="description"
          content="Verifiably Private AI chat application supporting open source models through Tinfoil"
        />
        <meta
          key="og:title"
          property="og:title"
          content="Tinfoil Private Chat"
        />
        <meta
          key="og:description"
          property="og:description"
          content="Private AI chat application supporting open source models through Tinfoil"
        />
        <meta key="og:type" property="og:type" content="website" />
        <meta key="twitter:card" name="twitter:card" content="summary" />
        <meta
          key="twitter:title"
          name="twitter:title"
          content="Tinfoil Private Chat"
        />
        <meta
          key="twitter:description"
          name="twitter:description"
          content="Private AI chat application supporting open source models through Tinfoil"
        />
      </Head>
      {router.isReady && !analyticsExcluded(router.asPath) && (
        <Script
          defer
          data-domain="chat.tinfoil.sh"
          data-api="https://plausible.io/api/event"
          src="/js/plausible.js"
          integrity="sha384-aYMHIcBsKU/BHnHb9YQ87pJcRsIlDvGVpR2yNRsefRzlfiI6WF2f+V4YKT5JO8f/"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
      )}
      <div
        className={`${aeonikFono.variable} ${aeonik.variable} ${openDyslexic.variable} ${lora.variable}`}
      >
        {/* Bundled from npm (no-rhc): nothing fetched from clerk.tinfoil.sh at runtime. */}
        <ClerkProvider
          Clerk={Clerk}
          ui={clerkUi}
          publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''}
          routerPush={(to) => router.push(to)}
          routerReplace={(to) => router.replace(to)}
          telemetry={false}
          afterSignOutUrl="/"
          signInUrl="/signin"
          appearance={{
            elements: {
              modalBackdrop: 'bg-black/50',
            },
          }}
        >
          <AuthTokenSync />
          <AuthCleanupHandler />
          <SignoutProgressOverlay />
          <Component {...pageProps} />
          <Toaster />
        </ClerkProvider>
      </div>
    </>
  )
}
