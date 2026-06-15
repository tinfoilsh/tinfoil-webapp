import { toast } from '@/hooks/use-toast'
import { downloadMarkdownAsPdf } from '@/utils/markdown-pdf-export'
import DOMPurify from 'isomorphic-dompurify'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { BsFiletypeMd, BsFiletypePdf } from 'react-icons/bs'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import {
  oneDark,
  oneLight,
} from 'react-syntax-highlighter/dist/cjs/styles/prism'
import remarkGfm from 'remark-gfm'
import { CONSTANTS } from './chat/constants'

const CodeIcon = () => (
  <svg
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
)

const EyeIcon = () => (
  <svg
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const PlayIcon = () => (
  <svg
    className="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)

const EXECUTABLE_LANGUAGES = [
  'html',
  'javascript',
  'js',
  'typescript',
  'ts',
  'python',
  'py',
]

const PYODIDE_CDN_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/'

const createIframeDataUrl = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

const DARK_THEME = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    background: 'transparent',
  },
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    background: 'transparent',
  },
  'token.operator': {
    ...oneDark['token.operator'],
    background: 'transparent',
  },
}

const LIGHT_THEME = {
  ...oneLight,
  'pre[class*="language-"]': {
    ...oneLight['pre[class*="language-"]'],
    background: 'transparent',
  },
  'code[class*="language-"]': {
    ...oneLight['code[class*="language-"]'],
    background: 'transparent',
  },
  'token.operator': {
    ...oneLight['token.operator'],
    background: 'transparent',
  },
}

type ViewMode = 'code' | 'preview'

const ViewModeToggle = ({
  mode,
  onModeChange,
  isDarkMode,
  language,
}: {
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
  isDarkMode: boolean
  language: string
}) => {
  const isExecutable = EXECUTABLE_LANGUAGES.includes(language)
  const PreviewIcon = isExecutable ? PlayIcon : EyeIcon

  return (
    <div
      className="flex rounded-md p-0.5"
      style={{
        background: isDarkMode ? 'rgb(31 41 55)' : 'rgb(229 231 235)',
      }}
    >
      <button
        onClick={() => onModeChange('preview')}
        className={`flex items-center justify-center rounded p-1.5 transition-colors ${
          mode === 'preview'
            ? isDarkMode
              ? 'bg-gray-700 text-white'
              : 'bg-white text-gray-900'
            : 'text-content-muted hover:text-content-secondary'
        }`}
        aria-label={isExecutable ? 'Run' : 'Preview'}
        aria-pressed={mode === 'preview'}
      >
        <PreviewIcon />
      </button>
      <button
        onClick={() => onModeChange('code')}
        className={`flex items-center justify-center rounded p-1.5 transition-colors ${
          mode === 'code'
            ? isDarkMode
              ? 'bg-gray-700 text-white'
              : 'bg-white text-gray-900'
            : 'text-content-muted hover:text-content-secondary'
        }`}
        aria-label="View code"
        aria-pressed={mode === 'code'}
      >
        <CodeIcon />
      </button>
    </div>
  )
}

const PREVIEWABLE_LANGUAGES = [
  'svg',
  'html',
  'markdown',
  'md',
  'javascript',
  'js',
  'typescript',
  'ts',
  'python',
  'py',
  'mermaid',
  'json',
  'css',
]

const isCodeWorthPreviewing = (code: string, language: string): boolean => {
  const trimmed = code.trim()

  if (trimmed.length < 20) return false

  if (!trimmed.includes('\n') && trimmed.length < 80) return false

  switch (language) {
    case 'html': {
      const tagCount = (trimmed.match(/<[a-z]/gi) || []).length
      if (tagCount <= 1) return false
      if (/^<(link|script|style|meta)\b/i.test(trimmed) && tagCount <= 2)
        return false
      return true
    }

    case 'javascript':
    case 'js':
    case 'typescript':
    case 'ts': {
      const withoutComments = trimmed
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .trim()
      if (withoutComments.length < 10) return false
      const hasLogic =
        /\b(if|for|while|function|=>|console\.|return|\.map|\.filter|\.reduce|\.forEach|async|await|new |class )/i.test(
          trimmed,
        )
      if (!hasLogic && trimmed.split('\n').length < 3) return false
      return true
    }

    case 'css': {
      const ruleCount = (trimmed.match(/\{/g) || []).length
      if (ruleCount < 1) return false
      const propertyCount = (trimmed.match(/:\s*[^;]+;/g) || []).length
      if (propertyCount < 2) return false
      return true
    }

    case 'svg': {
      return /<svg[\s\S]*<\/svg>/i.test(trimmed)
    }

    case 'markdown':
    case 'md': {
      const hasFormatting = /[#*`\[\]|]/.test(trimmed)
      return hasFormatting || trimmed.length > 100
    }

    case 'mermaid': {
      return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap)/m.test(
        trimmed,
      )
    }

    case 'json': {
      try {
        const parsed = JSON.parse(trimmed)
        if (typeof parsed !== 'object' || parsed === null) return false
        const keys = Object.keys(parsed)
        return keys.length > 0
      } catch {
        return false
      }
    }

    default:
      return true
  }
}

const PreviewContainer = ({
  children,
  isDarkMode,
}: {
  children: React.ReactNode
  isDarkMode: boolean
}) => (
  <div
    className={`min-h-[100px] rounded-lg p-4 pt-12 ${
      isDarkMode ? 'bg-surface-chat-background' : 'bg-surface-card'
    }`}
    style={{
      border: isDarkMode
        ? '1px solid rgb(31 41 55)'
        : '1px solid rgb(229 231 235)',
    }}
  >
    {children}
  </div>
)

const SvgPreview = ({ code }: { code: string }) => {
  const sanitizedSvg = DOMPurify.sanitize(code, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
  })

  return (
    <div
      className="flex w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-h-[400px] [&>svg]:w-full [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
    />
  )
}

const HtmlPreview = ({ code }: { code: string }) => {
  const [height, setHeight] = useState(100)
  const instanceId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }
      if (
        event.data?.type === 'html-preview-height' &&
        event.data?.instanceId === instanceId
      ) {
        setHeight(event.data.height)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [instanceId])

  const iframeSrc = useMemo(() => {
    // CSP blocks network requests (fetch, XHR, WebSocket, etc.)
    // Data URL ensures complete CSP isolation from parent page (null origin)
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:;">`

    const heightReporter = `
<script>
function reportHeight() {
  const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  parent.postMessage({ type: 'html-preview-height', instanceId: '${instanceId}', height }, '*');
}
window.addEventListener('load', reportHeight);
window.addEventListener('resize', reportHeight);
new MutationObserver(reportHeight).observe(document.body, { childList: true, subtree: true });
setTimeout(reportHeight, 100);
</script>`

    let html
    if (code.includes('<head>')) {
      html = code.replace('<head>', `<head>${csp}`) + heightReporter
    } else if (code.includes('</head>')) {
      html = code.replace('</head>', `${csp}${heightReporter}</head>`)
    } else {
      html = `${csp}${code}${heightReporter}`
    }
    return createIframeDataUrl(html)
  }, [code, instanceId])

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      className="w-full rounded border-0"
      style={{ height: `${height}px`, minHeight: '100px' }}
      sandbox="allow-scripts"
      title="HTML preview"
    />
  )
}

const MarkdownPreview = ({
  code,
  contentRef,
}: {
  code: string
  contentRef: React.RefObject<HTMLDivElement | null>
}) => (
  <div
    ref={contentRef as React.Ref<HTMLDivElement>}
    className="prose prose-sm max-w-none dark:prose-invert"
  >
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ node, children, ...props }: any) => (
          <div className="overflow-x-auto">
            <table {...props} className="w-full border-collapse">
              {children}
            </table>
          </div>
        ),
        th: ({ node, children, ...props }: any) => (
          <th
            {...props}
            className="bg-surface-secondary border border-border-subtle px-3 py-2 text-left"
          >
            {children}
          </th>
        ),
        td: ({ node, children, ...props }: any) => (
          <td {...props} className="border border-border-subtle px-3 py-2">
            {children}
          </td>
        ),
      }}
    >
      {code}
    </ReactMarkdown>
  </div>
)

const stripModuleSyntax = (code: string): string => {
  return code
    .replace(/^import\s+.*?['"];?\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\}\s*(from\s+['"][^'"]*['"])?\s*;?\s*$/gm, '')
    .replace(/^export\s+\*\s+from\s+['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/:\s*[A-Za-z_$][\w$]*(?:<[^>]+>)?(?:\[\])?(?=\s*[,)=;{\n])/g, '')
    .replace(/(<[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*>)(?=\s*\()/g, '')
    .replace(/\s+as\s+[A-Za-z_$][\w$]*(?:<[^>]+>)?/g, '')
    .replace(/^(interface|type)\s+[^{]+\{[^}]*\}\s*/gm, '')
}

const JavaScriptPreview = ({ code }: { code: string }) => {
  const [output, setOutput] = useState<string[]>([])
  const instanceId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const iframeSrc = useMemo(() => {
    const strippedCode = stripModuleSyntax(code)
    const jsonEscapedCode = JSON.stringify(strippedCode).replace(
      /<\/script>/gi,
      '<\\/script>',
    )

    // CSP blocks network requests (fetch, XHR, WebSocket, etc.)
    // Data URL ensures complete CSP isolation from parent page (null origin)
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';">
</head>
<body>
<script>
const output = [];
const originalLog = console.log;
console.log = (...args) => {
  output.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
try {
  const result = eval(${jsonEscapedCode});
  if (result !== undefined) {
    output.push('→ ' + (typeof result === 'object' ? JSON.stringify(result) : String(result)));
  }
} catch (e) {
  output.push('Error: ' + (e.message || String(e) || 'Unknown error'));
}
parent.postMessage({ type: 'js-preview-output', instanceId: '${instanceId}', output }, '*');
</script>
</body>
</html>`
    return createIframeDataUrl(html)
  }, [code, instanceId])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }
      if (
        event.data?.type === 'js-preview-output' &&
        event.data?.instanceId === instanceId
      ) {
        setOutput(event.data.output)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [instanceId])

  return (
    <div className="font-mono text-sm">
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className="hidden"
        sandbox="allow-scripts"
        title="JavaScript preview"
      />
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-content-muted">
        Console Output
      </div>
      {output.map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('Error:') ? 'text-red-500' : 'text-content-primary'
          }
        >
          {line}
        </div>
      ))}
      {output.length === 0 && (
        <div className="italic text-content-muted">No output</div>
      )}
    </div>
  )
}

const PythonPreview = ({ code }: { code: string }) => {
  const [output, setOutput] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const instanceId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const iframeSrc = useMemo(() => {
    const jsonEscapedCode = JSON.stringify(code).replace(
      /<\/script>/gi,
      '<\\/script>',
    )

    // CSP allows loading Pyodide from CDN
    // Data URL ensures isolation from parent page
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net;">
</head>
<body>
<script type="module">
const output = [];
parent.postMessage({ type: 'python-preview-loading', instanceId: '${instanceId}' }, '*');

try {
  const { loadPyodide } = await import('${PYODIDE_CDN_BASE}pyodide.mjs');
  const pyodide = await loadPyodide({
    indexURL: '${PYODIDE_CDN_BASE}'
  });

  pyodide.runPython(\`
import sys
from io import StringIO
sys.stdout = StringIO()
sys.stderr = StringIO()
\`);

  const userCode = ${jsonEscapedCode};
  try {
    const result = pyodide.runPython(userCode);
    const stdout = pyodide.runPython('sys.stdout.getvalue()');
    const stderr = pyodide.runPython('sys.stderr.getvalue()');
    
    if (stdout) {
      stdout.split('\\n').filter(line => line).forEach(line => output.push(line));
    }
    if (stderr) {
      stderr.split('\\n').filter(line => line).forEach(line => output.push('Error: ' + line));
    }
    if (result !== undefined && result !== null && !stdout) {
      const resultStr = String(result);
      if (resultStr !== 'None') {
        output.push('→ ' + resultStr);
      }
    }
  } catch (e) {
    output.push('Error: ' + (e.message || String(e) || 'Unknown error'));
  }
} catch (e) {
  output.push('Error loading Python: ' + (e.message || String(e) || 'Unknown error'));
}

parent.postMessage({ type: 'python-preview-output', instanceId: '${instanceId}', output }, '*');
</script>
</body>
</html>`
    return createIframeDataUrl(html)
  }, [code, instanceId])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }
      if (event.data?.instanceId !== instanceId) {
        return
      }
      if (event.data?.type === 'python-preview-loading') {
        setIsLoading(true)
      }
      if (event.data?.type === 'python-preview-output') {
        setOutput(event.data.output)
        setIsLoading(false)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [instanceId])

  return (
    <div className="font-mono text-sm">
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className="hidden"
        sandbox="allow-scripts"
        title="Python preview"
      />
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-content-muted">
        Python Output
      </div>
      {isLoading ? (
        <div className="italic text-content-muted">Loading Python...</div>
      ) : (
        <>
          {output.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('Error:')
                  ? 'text-red-500'
                  : 'text-content-primary'
              }
            >
              {line}
            </div>
          ))}
          {output.length === 0 && (
            <div className="italic text-content-muted">No output</div>
          )}
        </>
      )}
    </div>
  )
}

const MermaidPreview = ({
  code,
  isDarkMode,
}: {
  code: string
  isDarkMode: boolean
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const reactId = useId()
  const idRef = useMemo(
    () => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    [reactId],
  )

  useEffect(() => {
    let cancelled = false

    const renderMermaid = async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: isDarkMode ? 'dark' : 'default',
          securityLevel: 'strict',
        })

        const { svg: renderedSvg } = await mermaid.render(idRef, code)
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = renderedSvg
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          if (containerRef.current) {
            containerRef.current.innerHTML = ''
          }
        }
      }
    }

    renderMermaid()
    return () => {
      cancelled = true
    }
  }, [code, isDarkMode, idRef])

  if (error) {
    return <div className="text-sm text-red-500">Mermaid error: {error}</div>
  }

  return (
    <div
      ref={containerRef}
      className="flex w-full items-center justify-center [&>svg]:max-w-full"
    />
  )
}

const JsonTreeNode = ({
  data,
  name,
  isLast = true,
  depth = 0,
}: {
  data: unknown
  name?: string
  isLast?: boolean
  depth?: number
}) => {
  const [isExpanded, setIsExpanded] = useState(depth < 2)

  const isObject = typeof data === 'object' && data !== null
  const isArray = Array.isArray(data)
  const entries = isObject ? Object.entries(data) : []
  const hasChildren = entries.length > 0

  const getValueDisplay = () => {
    if (data === null) return <span className="text-orange-400">null</span>
    if (typeof data === 'boolean')
      return <span className="text-orange-400">{String(data)}</span>
    if (typeof data === 'number')
      return <span className="text-blue-400">{data}</span>
    if (typeof data === 'string')
      return <span className="text-green-400">&quot;{data}&quot;</span>
    return null
  }

  if (!isObject) {
    return (
      <div className="flex">
        {name !== undefined && (
          <span className="text-purple-400">&quot;{name}&quot;</span>
        )}
        {name !== undefined && <span className="text-content-muted">: </span>}
        {getValueDisplay()}
        {!isLast && <span className="text-content-muted">,</span>}
      </div>
    )
  }

  const nodeLabel = name ?? (isArray ? 'array' : 'object')

  return (
    <div>
      <button
        type="button"
        disabled={!hasChildren}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-label={
          hasChildren
            ? `${isExpanded ? 'Collapse' : 'Expand'} ${nodeLabel}`
            : undefined
        }
        className={`flex w-full text-left disabled:cursor-default ${hasChildren ? 'hover:bg-surface-secondary/50 cursor-pointer' : ''}`}
        onClick={() => {
          if (hasChildren) setIsExpanded(!isExpanded)
        }}
      >
        <span className="w-4 text-content-muted">
          {hasChildren ? (isExpanded ? '▼' : '▶') : ' '}
        </span>
        {name !== undefined && (
          <span className="text-purple-400">&quot;{name}&quot;</span>
        )}
        {name !== undefined && <span className="text-content-muted">: </span>}
        <span className="text-content-muted">{isArray ? '[' : '{'}</span>
        {!isExpanded && (
          <>
            <span className="text-content-muted">...</span>
            <span className="text-content-muted">{isArray ? ']' : '}'}</span>
            {!isLast && <span className="text-content-muted">,</span>}
          </>
        )}
      </button>
      {isExpanded && (
        <>
          <div className="ml-4">
            {entries.map(([key, value], i) => (
              <JsonTreeNode
                key={key}
                data={value}
                name={isArray ? undefined : key}
                isLast={i === entries.length - 1}
                depth={depth + 1}
              />
            ))}
          </div>
          <div className="flex">
            <span className="w-4" />
            <span className="text-content-muted">{isArray ? ']' : '}'}</span>
            {!isLast && <span className="text-content-muted">,</span>}
          </div>
        </>
      )}
    </div>
  )
}

const JsonPreview = ({ code }: { code: string }) => {
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<unknown>(null)

  useEffect(() => {
    try {
      setData(JSON.parse(code))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setData(null)
    }
  }, [code])

  if (error) {
    return <div className="text-sm text-red-500">JSON error: {error}</div>
  }

  return (
    <div className="overflow-x-auto font-mono text-sm">
      <JsonTreeNode data={data} />
    </div>
  )
}

const CssPreview = ({ code }: { code: string }) => {
  const [height, setHeight] = useState(150)
  const instanceId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }
      if (
        event.data?.type === 'css-preview-height' &&
        event.data?.instanceId === instanceId
      ) {
        setHeight(event.data.height)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [instanceId])

  const iframeSrc = useMemo(() => {
    const escapedCode = code.replace(/<\//g, '<\\/')
    // Data URL ensures complete CSP isolation from parent page (null origin)
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';">
  <style>${escapedCode}</style>
  <script>
    function reportHeight() {
      const height = Math.max(document.body.scrollHeight, 150);
      parent.postMessage({ type: 'css-preview-height', instanceId: '${instanceId}', height }, '*');
    }
    window.addEventListener('load', reportHeight);
    setTimeout(reportHeight, 100);
  </script>
</head>
<body style="margin: 0; padding: 16px; font-family: system-ui, sans-serif;">
  <h1>Heading 1</h1>
  <h2>Heading 2</h2>
  <p>This is a <strong>paragraph</strong> with <em>formatted</em> text and a <a href="#">link</a>.</p>
  <ul>
    <li>List item 1</li>
    <li>List item 2</li>
  </ul>
  <button>Button</button>
  <input type="text" placeholder="Input field" style="margin-left: 8px;">
  <div class="box" style="margin-top: 16px; padding: 16px; border: 1px solid #ccc; border-radius: 4px;">
    <p>A div with class "box"</p>
  </div>
</body>
</html>`
    return createIframeDataUrl(html)
  }, [code, instanceId])

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      className="w-full rounded border-0"
      style={{ height: `${height}px`, minHeight: '150px' }}
      sandbox="allow-scripts"
      title="CSS preview"
    />
  )
}

const CodePreview = ({
  code,
  language,
  isDarkMode,
  markdownRef,
}: {
  code: string
  language: string
  isDarkMode: boolean
  markdownRef?: React.RefObject<HTMLDivElement | null>
}) => {
  const renderPreview = () => {
    switch (language) {
      case 'svg':
        return <SvgPreview code={code} />
      case 'html':
        return <HtmlPreview code={code} />
      case 'markdown':
      case 'md':
        return <MarkdownPreview code={code} contentRef={markdownRef!} />
      case 'javascript':
      case 'js':
      case 'typescript':
      case 'ts':
        return <JavaScriptPreview code={code} />
      case 'python':
      case 'py':
        return <PythonPreview code={code} />
      case 'mermaid':
        return <MermaidPreview code={code} isDarkMode={isDarkMode} />
      case 'json':
        return <JsonPreview code={code} />
      case 'css':
        return <CssPreview code={code} />
      default:
        return null
    }
  }

  return (
    <PreviewContainer isDarkMode={isDarkMode}>
      {renderPreview()}
    </PreviewContainer>
  )
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  isDarkMode = true,
  isStreaming = false,
}: {
  code: string
  language: string
  isDarkMode?: boolean
  isStreaming?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false)
  const markdownRef = useRef<HTMLDivElement>(null)

  const isMarkdown = language === 'markdown' || language === 'md'
  const isExecutable = EXECUTABLE_LANGUAGES.includes(language)

  const languageSupportsPreview = PREVIEWABLE_LANGUAGES.includes(language)

  const codeIsWorthPreviewing =
    languageSupportsPreview && isCodeWorthPreviewing(code, language)

  // For non-executable languages during streaming, don't show preview at all
  // This prevents flickering as incomplete code causes preview errors
  const canShowPreview =
    languageSupportsPreview && (isExecutable || !isStreaming)

  const userHasToggledRef = useRef(false)

  const shouldStartInPreview =
    codeIsWorthPreviewing && !isExecutable && !isStreaming

  const [viewMode, setViewMode] = useState<ViewMode>(
    shouldStartInPreview ? 'preview' : 'code',
  )

  const wasStreamingRef = useRef(isStreaming)
  useEffect(() => {
    const streamingJustEnded = wasStreamingRef.current && !isStreaming
    wasStreamingRef.current = isStreaming

    if (
      streamingJustEnded &&
      codeIsWorthPreviewing &&
      !isExecutable &&
      !userHasToggledRef.current
    ) {
      setViewMode('preview')
    }
  }, [isStreaming, codeIsWorthPreviewing, isExecutable])

  const handleViewModeChange = (mode: ViewMode) => {
    userHasToggledRef.current = true
    setViewMode(mode)
  }

  const showPreview =
    canShowPreview && codeIsWorthPreviewing && viewMode === 'preview'

  const copyToClipboard = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), CONSTANTS.COPY_TIMEOUT_MS)
  }

  const downloadMarkdown = () => {
    const blob = new Blob([code], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'document.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadPdf = async () => {
    if (!markdownRef.current || isGeneratingPdf) return

    setIsGeneratingPdf(true)
    try {
      await downloadMarkdownAsPdf(markdownRef.current)
    } catch {
      toast({ title: 'Failed to generate PDF', variant: 'destructive' })
    } finally {
      setIsGeneratingPdf(false)
    }
  }

  return (
    <div className="group relative my-4">
      {canShowPreview && codeIsWorthPreviewing && (
        <div className="absolute left-2 top-2 z-10">
          <ViewModeToggle
            mode={viewMode}
            onModeChange={handleViewModeChange}
            isDarkMode={isDarkMode}
            language={language}
          />
        </div>
      )}
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        {isMarkdown && viewMode === 'preview' && (
          <>
            <div className="group/md relative">
              <button
                onClick={downloadMarkdown}
                aria-label="Download as Markdown"
                className="rounded-lg bg-surface-input p-2 hover:bg-surface-input/80"
              >
                <BsFiletypeMd
                  className="h-5 w-5 text-content-muted"
                  aria-hidden="true"
                />
              </button>
              <span className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary shadow-sm group-hover/md:block">
                .md
              </span>
            </div>
            <div className="group/pdf relative">
              <button
                onClick={downloadPdf}
                disabled={isGeneratingPdf}
                aria-label="Download as PDF"
                className="rounded-lg bg-surface-input p-2 hover:bg-surface-input/80 disabled:opacity-50"
              >
                <BsFiletypePdf
                  className={`h-5 w-5 ${isGeneratingPdf ? 'animate-pulse' : ''} text-content-muted`}
                  aria-hidden="true"
                />
              </button>
              <span className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary shadow-sm group-hover/pdf:block">
                {isGeneratingPdf ? 'Generating...' : 'PDF'}
              </span>
            </div>
          </>
        )}
        <div className="group/copy relative">
          <button
            onClick={copyToClipboard}
            aria-label={copied ? 'Copied' : 'Copy code'}
            className="rounded-lg bg-surface-input p-2 hover:bg-surface-input/80"
          >
            {copied ? (
              <svg
                className="h-5 w-5 text-green-400"
                fill="none"
                strokeWidth="1.5"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4.5 12.75l6 6 9-13.5"
                />
              </svg>
            ) : (
              <svg
                className="h-5 w-5 text-content-muted"
                fill="none"
                strokeWidth="1.5"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
                />
              </svg>
            )}
          </button>
          <span className="pointer-events-none absolute -top-8 right-0 hidden whitespace-nowrap rounded border border-border-subtle bg-surface-chat-background px-2 py-1 text-xs text-content-primary shadow-sm group-hover/copy:block">
            {copied ? 'Copied!' : 'Copy'}
          </span>
        </div>
      </div>
      {showPreview ? (
        <CodePreview
          code={code}
          language={language}
          isDarkMode={isDarkMode}
          markdownRef={markdownRef}
        />
      ) : isMarkdown ? (
        <pre
          tabIndex={0}
          aria-label={`Code block${language ? `, ${language}` : ''}`}
          className="font-mono text-sm"
          style={{
            borderRadius: '0.5rem',
            margin: 0,
            padding:
              canShowPreview && codeIsWorthPreviewing
                ? '3rem 1rem 1rem'
                : '1rem',
            background: isDarkMode
              ? `hsl(var(--surface-chat-background))`
              : `hsl(var(--surface-card))`,
            border: isDarkMode
              ? '1px solid rgb(31 41 55)'
              : '1px solid rgb(229 231 235)',
            overflowX: 'auto',
            overflowY: 'visible',
            maxWidth: '100%',
            whiteSpace: 'pre',
            tabSize: 4,
            color: isDarkMode
              ? 'hsl(var(--content-primary))'
              : 'hsl(var(--content-primary))',
          }}
        >
          {code}
        </pre>
      ) : (
        <SyntaxHighlighter
          language={language}
          tabIndex={0}
          aria-label={`Code block${language ? `, ${language}` : ''}`}
          style={isDarkMode ? DARK_THEME : LIGHT_THEME}
          customStyle={{
            borderRadius: '0.5rem',
            margin: 0,
            fontSize: '0.875rem',
            background: isDarkMode
              ? `hsl(var(--surface-chat-background))`
              : `hsl(var(--surface-card))`,
            border: isDarkMode
              ? '1px solid rgb(31 41 55)'
              : '1px solid rgb(229 231 235)',
            overflowX: 'auto',
            overflowY: 'visible',
            maxWidth: '100%',
            paddingTop:
              canShowPreview && codeIsWorthPreviewing ? '2.5rem' : '1rem',
          }}
          wrapLongLines={false}
        >
          {code}
        </SyntaxHighlighter>
      )}
    </div>
  )
})
