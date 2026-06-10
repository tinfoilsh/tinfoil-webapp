/**
 * Centralized file type detection utilities
 */

// Supported image extensions
const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
]

// Supported document extensions
const DOCUMENT_EXTENSIONS = {
  pdf: ['.pdf'],
  docx: ['.docx'],
  pptx: ['.pptx'],
  xlsx: ['.xlsx'],
  csv: ['.csv'],
}

// Supported media extensions
const MEDIA_EXTENSIONS = {
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm', '.wma'],
  video: ['.mp4', '.mov', '.avi'],
}

// Supported code extensions
const CODE_EXTENSIONS = {
  html: ['.html', '.htm', '.xhtml'],
  js: ['.js', '.jsx'],
  ts: ['.ts', '.tsx'],
  css: ['.css'],
  md: ['.md'],
  txt: ['.txt'],
}

// Financial data extensions that can be read as plain text
const FINANCIAL_EXTENSIONS = [
  '.qfx',
  '.qif',
  '.ofx',
  '.ifs',
  '.qbo',
  '.qbx',
  '.bai',
  '.bai2',
  '.mt940',
  '.sta',
  '.tsv',
  '.ics',
  '.vcf',
]

// Plain text / code extensions that can be read directly in the browser
const PLAIN_TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.bash',
  '.rb',
  '.java',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.go',
  '.rs',
  '.swift',
  '.kt',
  '.kts',
  '.r',
  '.sql',
  '.lua',
  '.pl',
  '.php',
  '.cs',
  '.csx',
  '.vb',
  '.fs',
  '.fsx',
  '.scala',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.ml',
  '.mli',
  '.clj',
  '.cljs',
  '.groovy',
  '.gradle',
  '.m',
  '.mm',
  '.zig',
  '.nim',
  '.jl',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.asm',
  '.s',
  '.proto',
  '.graphql',
  '.gql',
  '.tf',
  '.tfvars',
  '.dockerfile',
  '.makefile',
  '.cmake',
  '.tex',
  '.bib',
  '.svg',
  '.properties',
  '.lock',
  '.diff',
  '.patch',
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.rtf',
  ...FINANCIAL_EXTENSIONS,
]

// Archive extensions
const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.tar']

// All supported extensions combined
const ALL_SUPPORTED_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...Object.values(DOCUMENT_EXTENSIONS).flat(),
  ...Object.values(MEDIA_EXTENSIONS).flat(),
  ...Object.values(CODE_EXTENSIONS).flat(),
  ...PLAIN_TEXT_EXTENSIONS,
]

export function isSupportedFile(filename: string): boolean {
  const lowerFilename = filename.toLowerCase()
  return ALL_SUPPORTED_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))
}

// Number of leading bytes sampled when sniffing whether a file is text
const TEXT_SNIFF_SAMPLE_BYTES = 8192
// Maximum fraction of invalid UTF-8 sequences tolerated in a text file
const TEXT_SNIFF_MAX_INVALID_RATIO = 0.05

/**
 * Heuristically determines whether a file contains plain text by sampling
 * its leading bytes. Used as a fallback for unknown extensions so files
 * like ".cs" or other source code are not rejected outright.
 */
export async function isProbablyTextFile(file: File): Promise<boolean> {
  try {
    const buffer = await file.slice(0, TEXT_SNIFF_SAMPLE_BYTES).arrayBuffer()
    const bytes = new Uint8Array(buffer)
    if (bytes.length === 0) return false

    for (const byte of bytes) {
      if (byte === 0) return false
    }

    const decoded = new TextDecoder('utf-8').decode(bytes)
    let invalidCount = 0
    for (const char of decoded) {
      if (char === '\uFFFD') invalidCount++
    }
    return invalidCount / decoded.length <= TEXT_SNIFF_MAX_INVALID_RATIO
  } catch {
    return false
  }
}

/**
 * Checks if a filename has an image extension
 * @param filename - The filename to check
 * @returns true if the file has an image extension
 */
export function hasImageExtension(filename: string): boolean {
  const lowerFilename = filename.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))
}

export function isPlainTextFile(filename: string): boolean {
  const lowerFilename = filename.toLowerCase()
  return PLAIN_TEXT_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))
}

/**
 * Gets the file icon type based on the filename
 * @param filename - The filename to check
 * @returns A string representing the file type for icon display
 */
export function getFileIconType(filename: string): string {
  const lowerFilename = filename.toLowerCase()

  for (const [type, extensions] of Object.entries(DOCUMENT_EXTENSIONS)) {
    if (extensions.some((ext) => lowerFilename.endsWith(ext))) {
      return type
    }
  }

  if (hasImageExtension(filename)) {
    return 'image'
  }

  for (const [type, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if (extensions.some((ext) => lowerFilename.endsWith(ext))) {
      return type
    }
  }

  if (FINANCIAL_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))) {
    return 'csv'
  }

  if (ARCHIVE_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))) {
    return 'zip'
  }

  for (const [type, extensions] of Object.entries(CODE_EXTENSIONS)) {
    if (extensions.some((ext) => lowerFilename.endsWith(ext))) {
      return type
    }
  }

  return 'file'
}

/**
 * Gets the format type for document processing based on filename
 * @param filename - The filename to check
 * @returns A string representing the format for document processing
 */
export function getDocumentFormat(filename: string): string {
  const lowerFilename = filename.toLowerCase()

  if (lowerFilename.endsWith('.pdf')) return 'pdf'
  if (lowerFilename.endsWith('.docx')) return 'docx'
  if (lowerFilename.endsWith('.pptx')) return 'pptx'
  if (
    lowerFilename.endsWith('.html') ||
    lowerFilename.endsWith('.htm') ||
    lowerFilename.endsWith('.xhtml')
  )
    return 'html'
  if (lowerFilename.endsWith('.md')) return 'md'
  if (lowerFilename.endsWith('.csv')) return 'csv'
  if (lowerFilename.endsWith('.xlsx')) return 'xlsx'
  if (hasImageExtension(filename)) return 'image'
  if (lowerFilename.endsWith('.txt')) return 'asciidoc'

  // Default to pdf if we can't determine
  return 'pdf'
}
