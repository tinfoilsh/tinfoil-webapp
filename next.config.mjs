import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const { version: appVersion } = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
)

const isDev = process.env.NODE_ENV === 'development'

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

  // The in-origin preview runners (Python, CSS, Mermaid) run in opaque-origin
  // frames and import modules from /preview and /vendor, which is a CORS
  // fetch. Vercel sends this header from vercel.json; `next dev` needs it
  // here. Only defined in development: export ignores headers and warns
  // when the hook merely exists.
  ...(isDev
    ? {
        async headers() {
          return [
            {
              source: '/(preview|vendor)/:path*',
              headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
            },
          ]
        },
      }
    : {}),
}

export default nextConfig
