import { TINFOIL_COLORS } from '@/theme/colors'
import { logError } from '@/utils/error-handling'
import { useEffect, useState } from 'react'
import remarkGfm from 'remark-gfm'

interface PluginState {
  remarkPlugins: any[]
  rehypePlugins: any[]
}

// Module-level cache for stable plugin references
let cachedPlugins: PluginState | null = null
let loadingPromise: Promise<PluginState> | null = null

const INITIAL_PLUGINS: PluginState = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [],
}

async function loadPlugins(): Promise<PluginState> {
  if (cachedPlugins) {
    return cachedPlugins
  }

  if (loadingPromise) {
    return loadingPromise
  }

  loadingPromise = Promise.all([
    import('remark-math'),
    import('rehype-katex'),
    import('remark-breaks'),
    import('rehype-raw'),
  ])
    .then(([remarkMathMod, rehypeKatexMod, remarkBreaksMod, rehypeRawMod]) => {
      cachedPlugins = {
        remarkPlugins: [
          [remarkMathMod.default, { singleDollarTextMath: false }],
          remarkGfm,
          remarkBreaksMod.default,
        ],
        rehypePlugins: [
          rehypeRawMod.default,
          [
            rehypeKatexMod.default,
            {
              throwOnError: false,
              strict: false,
              output: 'htmlAndMathml',
              errorColor: TINFOIL_COLORS.utility.destructive,
              trust: false,
            },
          ],
        ],
      }
      return cachedPlugins
    })
    .catch((error) => {
      logError('Failed to load markdown plugins', error, {
        component: 'useMathPlugins',
        action: 'loadPlugins',
      })
      return INITIAL_PLUGINS
    })

  return loadingPromise
}

// Start loading immediately when this module is imported
if (typeof window !== 'undefined') {
  loadPlugins()
}

export function useMathPlugins(): PluginState {
  const [plugins, setPlugins] = useState<PluginState>(
    () => cachedPlugins ?? INITIAL_PLUGINS,
  )

  useEffect(() => {
    if (cachedPlugins) return

    let mounted = true
    loadPlugins().then((loaded) => {
      if (mounted) setPlugins(loaded)
    })
    return () => {
      mounted = false
    }
  }, [])

  return plugins
}
