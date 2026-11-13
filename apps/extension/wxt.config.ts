import { readdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'wxt'

const DEVELOPMENT_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArJZtiYh4iQtdvIJgJUvqw4wJAolhd+achnJAR2HMBuXJhqkGU0BLP1RYyLs/3fa4LLDWDIoOHl8dTw0E2F93WQBTAVX/tpxP1LfAZw+fOTyXnamS1OGWBhjW1GxqmkiTxWSoxtc1tqmCwJfvS0PnteJ0F9j9GUcnLf19xXZkUnwkT/BaS53+oS/NRkke2wYGcWUlOfzOgTD/LSFeVqRE67H2xU4CUq9iLjZpQ6/F8WNTqtLFOH6JZzKI+xuu6Xzbdo68Gv3g0YFAJ1DTYhzYQvmO7W4SKyHIMhwxtdQ3nh1t/8nE0KsxGGh/TGn4q09q8DvXjdkpSPuWqmCYHWIGnwIDAQAB'
const LOCAL_WEBAPP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const MODEL_ICONS = 'model-icons'
// The logo on a tile of its own, which shows on a toolbar of any color.
const ICON_SIZES = [16, 32, 48, 128]

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  imports: false,
  webExt: { disabled: true },
  hooks: {
    'build:publicAssets'(wxt, files) {
      const webPublic = path.resolve(wxt.config.root, '../../public')
      for (const name of [
        'icons/chevron-right.svg',
        'logo-green.svg',
        'logo-white.svg',
        ...readdirSync(path.join(webPublic, MODEL_ICONS)).map((icon) =>
          path.join(MODEL_ICONS, icon),
        ),
      ]) {
        files.push({
          absoluteSrc: path.join(webPublic, name),
          relativeDest: name,
        })
      }
    },
  },
  manifest: () => {
    const origins = new Set(['https://*.tinfoil.sh/*'])
    for (const value of [
      process.env.WXT_CLERK_FRONTEND_API,
      process.env.WXT_HARNESS_URL,
      process.env.WXT_CONTROLPLANE_URL,
    ]) {
      if (!value) continue
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Extension services must use HTTPS origins')
      origins.add(`${url.origin}/*`)
    }
    if (process.env.WXT_WEBAPP_URL) {
      const url = new URL(process.env.WXT_WEBAPP_URL)
      const localHTTP =
        url.protocol === 'http:' && LOCAL_WEBAPP_HOSTS.has(url.hostname)
      if (
        (!localHTTP && url.protocol !== 'https:') ||
        url.username ||
        url.password
      )
        throw new Error('The webapp must use HTTPS or a local HTTP origin')
      origins.add(`${url.origin}/*`)
    }
    return {
      name: 'Tinfoil',
      description:
        'Private chat and browser actions with attested Tinfoil models.',
      minimum_chrome_version: '142',
      key: process.env.WXT_EXTENSION_PUBLIC_KEY || DEVELOPMENT_PUBLIC_KEY,
      permissions: [
        'cookies',
        'debugger',
        'sidePanel',
        'storage',
        'tabGroups',
        'tabs',
      ],
      host_permissions: [...origins],
      action: { default_title: 'Open Tinfoil' },
      icons: Object.fromEntries(
        ICON_SIZES.map((size) => [size, `icon/${size}.png`]),
      ),
      commands: {
        'stop-task': {
          suggested_key: { default: 'Alt+Shift+S' },
          description: 'Stop the current browser task',
        },
      },
    }
  },
})
