import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))

const isDev = process.env.NODE_ENV === 'development'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDev ? {} : { output: 'export' }),
  outputFileTracingRoot: projectRoot,

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
}

export default nextConfig
