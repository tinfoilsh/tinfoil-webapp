import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const { version: appVersion } = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
)

const isDev = process.env.NODE_ENV === 'development'

// Defense-in-depth: NEXT_PUBLIC_DEV bypasses enclave attestation and must
// never be baked into a deployed bundle. Local static testing (see dev.md)
// builds with this flag on purpose, so the guard
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

  // Local development API gateway. Next only separates model-router traffic;
  // the port-3001 gateway owns mock registration and controlplane forwarding.
  async rewrites() {
    if (!isLocalDevProxyEnabled) return []

    return [
      {
        source: '/api/local-router/:path*',
        destination: 'http://localhost:8090/:path*',
      },
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/api/:path*',
      },
    ]
  },
}

export default nextConfig
