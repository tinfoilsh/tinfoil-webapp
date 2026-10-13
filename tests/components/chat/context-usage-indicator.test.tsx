import { ContextUsageIndicator } from '@/components/chat/components/context-usage-indicator'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('context usage indicator', () => {
  it('explains an oversized prompt and clears the warning when it fits again', () => {
    const { rerender } = render(
      <ContextUsageIndicator
        usage={{ usedTokens: 600, limitTokens: 800, percentage: 75 }}
      />,
    )
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Context window 75% used (~600 of 800 tokens)',
    )

    rerender(
      <ContextUsageIndicator
        usage={{ usedTokens: 1000, limitTokens: 800, percentage: 125 }}
      />,
    )
    expect(screen.getByText('Over limit')).toBeVisible()
    expect(screen.getByRole('img')).toHaveAccessibleName(
      "Context exceeds this model's input budget (~1k of 800 tokens). Replies may fail. Reduce project documents or instructions, remove attachments, or shorten your message.",
    )

    rerender(
      <ContextUsageIndicator
        usage={{ usedTokens: 400, limitTokens: 800, percentage: 50 }}
      />,
    )
    expect(screen.queryByText('Over limit')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Context window 50% used (~400 of 800 tokens)',
    )
  })

  it('distinguishes a full budget from an overflow', () => {
    render(
      <ContextUsageIndicator
        usage={{ usedTokens: 800, limitTokens: 800, percentage: 100 }}
      />,
    )
    expect(screen.getByText('100%')).toBeVisible()
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Context window full (~800 tokens). Older messages may be omitted to make room.',
    )
    expect(screen.queryByText('Over limit')).not.toBeInTheDocument()
  })
})
