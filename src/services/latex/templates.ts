/**
 * LaTeX document templates served from `public/latex-templates/`.
 *
 * Every template starts with a PERSONALIZATION block of macros that the
 * model fills through the `render_latex_document` widget; `fillTemplate`
 * swaps those values and, optionally, the document body. All templates load
 * the shared `tinfoil-base.sty`, which must be shipped next to `main.tex`.
 */
export const LATEX_TEMPLATES = {
  letter: {
    file: 'letter.tex',
    description: 'personal letter',
    body: 'the letter paragraphs only; greeting, closing and signature come from the fields',
    fields: [
      'SenderName',
      'SenderAddress',
      'SenderEmail',
      'RecipientBlock',
      'LetterDate',
      'Greeting',
      'Closing',
    ],
  },
  'formal-letter': {
    file: 'formal-letter.tex',
    description:
      'business letter with letterhead, reference line and legal footer',
    body: 'the letter paragraphs only; greeting, closing and signature come from the fields',
    fields: [
      'CompanyName',
      'CompanyAddress',
      'CompanyContact',
      'CompanyLegal',
      'SenderName',
      'SenderTitle',
      'RecipientBlock',
      'LetterDate',
      'Reference',
      'Subject',
      'Greeting',
      'Closing',
    ],
  },
  cv: {
    file: 'cv.tex',
    description:
      'CV / resume (body uses \\cventry{dates}{title}{organisation}{description})',
    body: 'a one-paragraph summary, then \\section{Experience} with \\cventry{dates}{title}{organisation}{description} entries, \\section{Education}, \\section{Skills} as a tabular with \\lab labels',
    fields: ['Name', 'Headline', 'ContactLine'],
  },
  report: {
    file: 'report.tex',
    description: 'report, memo or proposal',
    body: 'a keybox{Summary} panel, then numbered \\section and \\subsection text with itemize lists and booktabs tables',
    fields: [
      'ReportTitle',
      'ReportSubtitle',
      'Author',
      'Organisation',
      'ReportDate',
    ],
  },
  slides: {
    file: 'slides.tex',
    description: 'beamer slides, 16:9',
    body: '\\section and \\begin{frame}{Title}...\\end{frame} slides, at most six bullets per frame; the title and closing frames are in the template',
    fields: ['title', 'subtitle', 'author', 'institute', 'date'],
  },
  paper: {
    file: 'paper.tex',
    description: 'academic paper or essay',
    body: 'a keybox{Abstract} with a Keywords line, \\section text with equations, tables and \\citep, then a thebibliography',
    fields: ['PaperTitle', 'Authors', 'Affiliations', 'Keywords'],
  },
  invoice: {
    file: 'invoice.tex',
    description:
      'invoice (body uses \\invoiceline{description}{qty}{unit price}{amount} rows)',
    body: '\\invoiceline{description}{qty}{unit price}{amount} rows only; subtotal, tax and total are fields',
    fields: [
      'CompanyName',
      'CompanyAddress',
      'CompanyContact',
      'ClientBlock',
      'InvoiceNumber',
      'InvoiceDate',
      'DueDate',
      'Terms',
      'Currency',
      'Subtotal',
      'TaxLabel',
      'Tax',
      'Total',
      'PaymentDetails',
      'Notes',
    ],
  },
  contract: {
    file: 'contract.tex',
    description:
      'contract or agreement with numbered clauses and signature blocks',
    body: 'a Recitals heading and paragraph, then \\section{Clause title} with \\subsection{clause text} items; parties and signature blocks are in the template',
    fields: [
      'ContractTitle',
      'EffectiveDate',
      'PartyAName',
      'PartyADetails',
      'PartyAShort',
      'PartyBName',
      'PartyBDetails',
      'PartyBShort',
    ],
  },
  notes: {
    file: 'notes.tex',
    description:
      'notes with margin notes (\\sidenote), key boxes and a checklist',
    body: '\\section headings with text, \\sidenote{} margin notes, keybox{Title} panels, tables and a \\todo{}/\\done{} checklist',
    fields: ['NotesTitle', 'NotesSubtitle', 'NotesMeta'],
  },
} as const

export type LatexTemplateName = keyof typeof LATEX_TEMPLATES
export const LATEX_TEMPLATE_NAMES = Object.keys(LATEX_TEMPLATES) as [
  LatexTemplateName,
  ...LatexTemplateName[],
]
export const LATEX_BASE_STYLE = 'tinfoil-base.sty'
export const LATEX_TEMPLATES_PATH = '/latex-templates/'

const sources = new Map<string, Promise<string>>()

function fetchSource(file: string): Promise<string> {
  let source = sources.get(file)
  if (!source) {
    source = fetch(LATEX_TEMPLATES_PATH + file).then((response) => {
      if (!response.ok)
        throw new Error(`Template ${file}: HTTP ${response.status}`)
      return response.text()
    })
    source.catch(() => sources.delete(file))
    sources.set(file, source)
  }
  return source
}

export async function loadTemplateSources(
  template: LatexTemplateName,
): Promise<{ main: string; base: string }> {
  const [main, base] = await Promise.all([
    fetchSource(LATEX_TEMPLATES[template].file),
    fetchSource(LATEX_BASE_STYLE),
  ])
  return { main, base }
}

/** Index just past the `}` that closes the group opened at `open`, or -1. */
function closingBrace(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
    } else if (ch === '{') {
      depth++
    } else if (ch === '}' && --depth === 0) {
      return i + 1
    }
  }
  return -1
}

const BODY_START = '% ---- BODY ----\n'
const BODY_END = '% ---- END BODY ----'

/**
 * Replace personalization macro values and, when given, the editable body
 * region (falling back to the whole document environment when a template
 * has no markers). Fields are matched as `\newcommand{\Key}{...}` or a line
 * starting with `\Key{...}` (beamer's `\title{...}`); unknown keys are ignored.
 */
export function fillTemplate(
  source: string,
  fields: Record<string, string> = {},
  body?: string,
): string {
  let out = source
  for (const [key, value] of Object.entries(fields)) {
    const heads = [`\\newcommand{\\${key}}{`, `\n\\${key}{`]
    for (const head of heads) {
      const at = out.indexOf(head)
      if (at < 0) continue
      const open = at + head.length - 1
      const close = closingBrace(out, open)
      if (close < 0) break
      out = `${out.slice(0, open + 1)}${value}${out.slice(close - 1)}`
      break
    }
  }
  if (body !== undefined) {
    const bodyStart = out.indexOf(BODY_START)
    const bodyEnd = out.indexOf(BODY_END, bodyStart)
    const start = out.indexOf('\\begin{document}')
    const end = out.lastIndexOf('\\end{document}')
    if (bodyStart >= 0 && bodyEnd > bodyStart) {
      out = `${out.slice(0, bodyStart + BODY_START.length)}${body.trim()}\n${out.slice(bodyEnd)}`
    } else if (start >= 0 && end > start) {
      out = `${out.slice(0, start)}\\begin{document}\n${body.trim()}\n${out.slice(end)}`
    }
  }
  return out
}
