import { MermaidPreview } from '@/components/preview/mermaid-preview'
import { SvgPreview } from '@/components/preview/svg-preview'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  format: z
    .enum(['svg', 'mermaid'])
    .describe('`svg` for raw SVG markup, `mermaid` for mermaid diagram source'),
  code: z.string().describe('Diagram source or SVG markup'),
  title: z.string().optional(),
  caption: z.string().optional(),
})

export const widget = defineGenUIWidget({
  name: 'render_artifact_preview',
  description:
    'Display a visual artifact: an SVG illustration or a mermaid diagram. Use for flowcharts, sequence diagrams, ER diagrams, gantt charts, and small vector illustrations.',
  schema,
  promptHint: 'mermaid diagrams or SVG illustrations',
  render: ({ format, code, title, caption }, ctx) => (
    <figure className="my-3 rounded-lg border border-border-subtle bg-surface-card p-4">
      {title && (
        <figcaption className="mb-2 text-sm font-medium text-content-primary">
          {title}
        </figcaption>
      )}
      {format === 'mermaid' ? (
        <MermaidPreview code={code} isDarkMode={Boolean(ctx.isDarkMode)} />
      ) : (
        <SvgPreview code={code} />
      )}
      {caption && (
        <figcaption className="mt-2 text-xs text-content-muted">
          {caption}
        </figcaption>
      )}
    </figure>
  ),
})
