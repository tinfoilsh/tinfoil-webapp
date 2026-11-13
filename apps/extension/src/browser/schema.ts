import type { BrowserAction } from '@tinfoil/chat-client/types'
import { z } from 'zod'
import { BrowserError } from './errors'

export const actionSchema = z
  .object({
    action: z.enum([
      'tabs',
      'read',
      'screenshot',
      'click',
      'hover',
      'fill',
      'select',
      'press',
      'scroll',
      'navigate',
      'back',
      'forward',
      'open',
      'switch',
      'close',
      'wait',
    ]),
    tabId: z.number().int().positive().optional(),
    ref: z.string().max(200).optional(),
    text: z.string().max(16_000).optional(),
    url: z.string().max(4_000).optional(),
    key: z
      .enum([
        'Enter',
        'Tab',
        'Escape',
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'Backspace',
      ])
      .optional(),
    direction: z.enum(['up', 'down']).optional(),
    screenshotId: z.string().max(200).optional(),
    x: z.number().finite().nonnegative().optional(),
    y: z.number().finite().nonnegative().optional(),
  })
  .strict() satisfies z.ZodType<BrowserAction>

export function webURL(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined
  if (
    !url ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new BrowserError('INVALID_URL', 'Choose an HTTP or HTTPS page.')
  return url.href
}

const READ_ACTIONS = new Set<BrowserAction['action']>([
  'tabs',
  'read',
  'screenshot',
  'wait',
])
export const changesPage = (action: BrowserAction) =>
  !READ_ACTIONS.has(action.action)
