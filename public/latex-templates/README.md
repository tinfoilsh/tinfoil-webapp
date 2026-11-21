# LaTeX document templates

Templates for the `render_latex_document` widget (`src/components/chat/genui/
widgets/LatexDocument.tsx`), fetched from this folder at runtime. All share one
style file, `tinfoil-base.sty`, which the widget ships next to `main.tex`. The
field list per template lives in `src/services/latex/templates.ts` and is
checked against these files by `tests/services/latex-templates.test.ts`. Each compiles with `@lsd-cat/tstex` against its
`minimal` bundle (verified 2026-11-21).

| File                | Use                                                 |
| ------------------- | --------------------------------------------------- |
| `letter.tex`        | personal letter                                     |
| `formal-letter.tex` | business letter with letterhead and reference block |
| `cv.tex`            | CV / resume                                         |
| `report.tex`        | report / memo / proposal                            |
| `slides.tex`        | slides (beamer 16:9)                                |
| `paper.tex`         | academic paper / essay (uses the `serif` option)    |
| `invoice.tex`       | invoice with item table and totals                  |
| `contract.tex`      | contract with numbered clauses and signature blocks |
| `notes.tex`         | notes with margin notes, key boxes and a checklist  |

## The base style

- Sans body (Computer Modern Sans); `\usepackage[serif]{tinfoil-base}` switches
  to Times. These are the only complete font families in the bundle.
- One accent colour plus greys: `accent`, `ink`, `muted`, `line`, `tint`.
  Change the accent after loading with `\definecolor{accent}{HTML}{...}`.
- Helpers: `\docheader{title}{subtitle}`, `\accentbar`, `\lab{small caps label}` (also used
  for table headers), `\hairline`, `\twocol{left}{right}`, `\sigline{caption}`,
  the `keybox` environment, `\runninghead{text}`.
- Articles get A4, 2.5 cm margins, fancyhdr with the page number bottom right,
  hyperref with coloured links, accent-coloured section numbers; key boxes are
  rounded TikZ panels. Beamer gets a plain white theme
  with the same colours.

## Conventions

- Every template starts with a `PERSONALIZATION` block of `\newcommand`
  macros (names, addresses, dates). Fill those from the user's input; the body
  below is sample content for the model to replace.
- A `logo.png` placed next to the main file is picked up by the formal letter,
  CV and invoice via `\IfFileExists`; without it a text wordmark is used.

## Bundle limits

- `titlesec`, `enumitem`, `tcolorbox`, `multicol`, `tabularx`, `colortbl` and
  `grfext` are not in the bundle. The base disables `epstopdf-base` (which
  needs `grfext`) because it would otherwise load whenever the last
  `\usepackage` had options.
- Libertine, Biolinum, Helvetica and Inconsolata ship without italic or regular
  outlines and crash at PDF output. Do not use them.
- `\textbullet` and other TS1 symbols are unavailable: use `$\bullet$`.
- Inside a `p{}` tabular column `\\` ends the row; use `\twocol` or a minipage
  for multi-line blocks.
