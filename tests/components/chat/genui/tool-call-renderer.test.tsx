import { GenUIToolCallRenderer } from '@/components/chat/genui/GenUIToolCallRenderer'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('GenUIToolCallRenderer', () => {
  it('renders completed widget arguments while the assistant stream continues', () => {
    render(
      <GenUIToolCallRenderer
        isStreaming
        toolCalls={[
          {
            id: 'tool-call-1',
            name: 'render_message_compose',
            arguments: JSON.stringify({
              channel: 'message',
              title: 'Reply draft',
              variants: [
                {
                  label: 'Concise',
                  body: 'Thanks, I will confirm the details.',
                },
              ],
            }),
          },
        ]}
      />,
    )

    expect(screen.getByText('Reply draft')).toBeInTheDocument()
    expect(
      screen.queryByText(/Generating message compose/),
    ).not.toBeInTheDocument()
  })

  it('keeps the streaming tracer while widget arguments are incomplete', () => {
    render(
      <GenUIToolCallRenderer
        isStreaming
        toolCalls={[
          {
            id: 'tool-call-1',
            name: 'render_message_compose',
            arguments: '{"title":"Reply draft"',
          },
        ]}
      />,
    )

    expect(screen.getByText(/Generating message compose/)).toBeInTheDocument()
  })
})
