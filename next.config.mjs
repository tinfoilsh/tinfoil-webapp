import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const { version: appVersion } = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
)

const isDev = process.env.NODE_ENV === 'development'

// Defense-in-depth: NEXT_PUBLIC_DEV bypasses enclave attestation and must
// never be baked into a deployed bundle. Local static testing (see
// LOCAL_TESTING.md "Option B") builds with this flag on purpose, so the guard
// only trips in a hosted build environment (Vercel/CI).
const isHostedBuild = Boolean(process.env.VERCEL || process.env.CI)
if (isHostedBuild && process.env.NEXT_PUBLIC_DEV === 'true') {
  throw new Error(
    'NEXT_PUBLIC_DEV=true is not allowed in a deployed build: it disables enclave attestation. Unset NEXT_PUBLIC_DEV for production/preview deploys.',
  )
}

// Local development reverse proxy. This is deliberately gated by both
// Next's development server and Tinfoil's explicit local-dev flag. Static
// local builds use scripts/dev-serve.mjs instead of Next rewrites.
const isLocalDevProxyEnabled = isDev && process.env.NEXT_PUBLIC_DEV === 'true'

function parseLocalControlplaneProxyOrigin(raw) {
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return `${url.protocol}//${url.host}`
}

const localControlplaneProxyOrigin = isLocalDevProxyEnabled
  ? parseLocalControlplaneProxyOrigin(process.env.NEXT_PUBLIC_API_BASE_URL)
  : null

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDev ? {} : { output: 'export' }),
  outputFileTracingRoot: projectRoot,
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },

  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },

  // Performance optimizations
  compress: true,
  poweredByHeader: false,

  // Optimize production builds
  productionBrowserSourceMaps: false,

  // Tree-shake large icon and utility packages.
  experimental: {
    optimizePackageImports: ['react-icons', 'lucide-react', '@heroicons/react'],
  },

  // Local development API proxy. Order matters: local and mocked routes must
  // come before the catch-all that forwards to the real controlplane.
  async rewrites() {
    if (!isLocalDevProxyEnabled) return []

    const localRoutes = [
      {
        source: '/api/dev/simulator',
        destination: 'http://localhost:3001/api/dev/simulator',
      },
      {
        source: '/api/dev/safeguard-flags',
        destination: 'http://localhost:3001/api/dev/safeguard-flags',
      },
      {
        source: '/api/local-router/:path*',
        destination: 'http://localhost:8090/:path*',
      },
      {
        source: '/api/users/me/safeguard-flags',
        destination: 'http://localhost:3001/api/users/me/safeguard-flags',
      },
    ]
    if (!localControlplaneProxyOrigin) return localRoutes
    return [
      ...localRoutes,
      // Catch-all: everything else under /api/* forwards to the real
      // controlplane so Clerk/billing/cloud continue to work in dev.
      {
        source: '/api/:path*',
        destination: `${localControlplaneProxyOrigin}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
