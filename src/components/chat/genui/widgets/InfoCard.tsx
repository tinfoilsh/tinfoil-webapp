import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const schema = z.object({
  title: z.string().describe('Card title'),
  description: z
    .string()
    .optional()
    .describe('Short description shown below the title'),
  content: z
    .string()
    .optional()
    .describe(
      'Main body content. Supports GitHub-flavored markdown — use "- item" for lists and "**bold**" for emphasis.',
    ),
  footer: z.string().optional().describe('Footer text at the bottom'),
})

export const widget = defineGenUIWidget({
  name: 'render_info_card',
  description:
    'Display a highlighted card with structured information. Use for a single key fact, definition, or summary.',
  schema,
  promptHint: 'highlighted card for a key fact, definition, or summary',
  render: ({ title, description, content, footer }) => (
    <Card className="my-3 max-w-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {content && (
        <CardContent>
          <div className="prose prose-sm max-w-none text-sm text-content-primary dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </CardContent>
      )}
      {footer && (
        <CardFooter>
          <p className="text-xs text-content-muted">{footer}</p>
        </CardFooter>
      )}
    </Card>
  ),
})
