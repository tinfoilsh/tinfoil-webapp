import {
  LATEX_BASE_STYLE,
  LATEX_TEMPLATES,
  LATEX_TEMPLATE_NAMES,
  fillTemplate,
} from '@/services/latex/templates'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string) =>
  readFileSync(`public/latex-templates/${file}`, 'utf8')

function personalizationMacros(source: string): string[] {
  const block = source.match(/% ---- PERSONALIZATION[^\n]*\n([\s\S]*?)% -{20,}/)
  return [
    ...(block?.[1] ?? '').matchAll(/^\\(?:newcommand\{\\(\w+)\}|(\w+))\{/gm),
  ].map((m) => m[1] ?? m[2])
}

describe('LaTeX templates', () => {
  it('lists exactly the personalization macros of each template file', () => {
    for (const name of LATEX_TEMPLATE_NAMES) {
      const { file, fields } = LATEX_TEMPLATES[name]
      expect(personalizationMacros(read(file)), file).toEqual([...fields])
      expect(read(file)).toContain('tinfoil-base')
      expect(read(file)).toMatch(
        /% ---- BODY ----\n[\s\S]+% ---- END BODY ----/,
      )
    }
    expect(read(LATEX_BASE_STYLE)).toContain('ProvidesPackage{tinfoil-base}')
  })

  it('fills macros with nested braces and replaces the body', () => {
    const source = read('letter.tex')
    const filled = fillTemplate(
      source,
      { SenderName: 'Ada {Lovelace}', Unknown: 'x', Greeting: 'Hi,' },
      'Hello.',
    )
    expect(filled).toContain('\\newcommand{\\SenderName}{Ada {Lovelace}}')
    expect(filled).toContain('\\newcommand{\\Greeting}{Hi,}')
    expect(filled).not.toContain('Maya Okafor')
    expect(filled).not.toContain('Unknown')
    expect(filled).toMatch(/% ---- BODY ----\nHello\.\n% ---- END BODY ----/)
    expect(filled).not.toContain('I hope this finds you well')
    expect(filled).toContain('\\Greeting\n')
    expect(filled).toContain('\\Closing\n')
  })

  it('fills beamer title macros and keeps the body when none is given', () => {
    const filled = fillTemplate(read('slides.tex'), {
      title: 'Talk',
      date: '1 Jan',
    })
    expect(filled).toContain('\n\\title{Talk}')
    expect(filled).toContain('\n\\date{1 Jan}')
    expect(filled).toContain('\\begin{frame}[plain]\\titlepage\\end{frame}')
  })
})
