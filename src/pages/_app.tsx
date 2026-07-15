import { AuthCleanupHandler } from '@/components/auth-cleanup-handler'
import { SignoutProgressOverlay } from '@/components/signout-progress-overlay'
import { Toaster } from '@/components/ui/toaster'
import '@/styles/globals.css'
import '@/styles/tailwind.css'
import { migrateStorageKeys } from '@/utils/storage-migration'
import { ClerkProvider } from '@clerk/nextjs'
import type { AppProps } from 'next/app'
import localFont from 'next/font/local'
import Head from 'next/head'

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
  display: 'swap',
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
  display: 'swap',
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
  display: 'swap',
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
  display: 'swap',
})

migrateStorageKeys()

export default function App({ Component, pageProps }: AppProps) {
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
      <style jsx global>{`
        :root {
          --font-aeonik-fono: ${aeonikFono.style.fontFamily};
          --font-aeonik: ${aeonik.style.fontFamily};
          --font-opendyslexic: ${openDyslexic.style.fontFamily};
          --font-lora: ${lora.style.fontFamily};
        }
      `}</style>
      <div
        className={`${aeonikFono.variable} ${aeonik.variable} ${openDyslexic.variable} ${lora.variable}`}
      >
        <ClerkProvider
          telemetry={false}
          afterSignOutUrl="/"
          signInUrl="/signin"
          appearance={{
            elements: {
              modalBackdrop: 'bg-black/50',
            },
          }}
        >
          <AuthCleanupHandler />
          <SignoutProgressOverlay />
          <Component {...pageProps} />
          <Toaster />
        </ClerkProvider>
      </div>
    </>
  )
}
