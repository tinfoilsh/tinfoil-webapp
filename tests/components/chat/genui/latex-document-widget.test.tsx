// @vitest-environment jsdom
import { widget } from '@/components/chat/genui/widgets/LatexDocument'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const compileLatex = vi.fn()
vi.mock('@/services/latex/compile', async (importActual) => ({
  ...(await importActual<typeof import('@/services/latex/compile')>()),
  compileLatex: (...args: unknown[]) => compileLatex(...args),
}))
vi.mock('@/services/latex/templates', async (importActual) => ({
  ...(await importActual<typeof import('@/services/latex/templates')>()),
  loadTemplateSources: async () => ({
    main: '\\newcommand{\\SenderName}{X}\n\\begin{document}\nsample\n\\end{document}',
    base: 'BASE',
  }),
}))

afterEach(() => {
  cleanup()
  compileLatex.mockReset()
  localStorage.clear()
})

const pdf = new TextEncoder().encode('%PDF')
const renderWidget = (retryToolCall?: (reason: string) => Promise<boolean>) =>
  render(
    widget.render!(
      {
        template: 'letter',
        title: 'Note',
        fields: { SenderName: 'Ada' },
        body: 'Hi',
      },
      { toolCallId: 'tc1', retryToolCall },
    )!,
  )

describe('render_latex_document', () => {
  it('compiles the filled template with the base style and shows the page count', async () => {
    compileLatex.mockResolvedValue({
      ok: true,
      pdf,
      log: 'Output written on main.pdf (2 pages, 10 bytes).',
    })
    const { getByText } = renderWidget()
    await waitFor(() =>
      expect(getByText('PDF ready, 2 pages')).toBeInTheDocument(),
    )
    const [files] = compileLatex.mock.calls[0] as [Record<string, string>]
    expect(files['tinfoil-base.sty']).toBe('BASE')
    expect(files['main.tex']).toBe(
      '\\newcommand{\\SenderName}{Ada}\n\\begin{document}\nHi\n\\end{document}',
    )
    expect(getByText('Note')).toBeInTheDocument()
  })

  it('asks the model once to repair a failed compile with the error excerpt', async () => {
    compileLatex.mockResolvedValue({
      ok: false,
      pdf: null,
      log: 'x\n! Undefined control sequence.\nl.3 \\foo\n\ny',
    })
    const retry = vi.fn().mockResolvedValue(false)
    const { getByText } = renderWidget(retry)
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    expect(retry.mock.calls[0][0]).toBe(
      'The LaTeX failed to compile:\n! Undefined control sequence.\nl.3 \\foo\n',
    )
    await waitFor(() => expect(getByText('Compile failed')).toBeInTheDocument())
    await act(async () => {})
    expect(retry).toHaveBeenCalledTimes(1)
    expect(getByText('Fix')).toBeInTheDocument()
  })
})
