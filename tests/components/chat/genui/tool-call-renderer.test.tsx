import { CONSTANTS } from '@/components/chat/constants'
import { GenUIToolCallRenderer } from '@/components/chat/genui/GenUIToolCallRenderer'
import { GENUI_WIDGETS_BY_NAME } from '@/components/chat/genui/registry'
import { ArtifactRetryError } from '@/components/chat/genui/retry'
import type { GenUIRenderContext } from '@/components/chat/genui/types'
import {
  artifactPreviewTargetsEqual,
  OPEN_ARTIFACT_PREVIEW_EVENT,
  type ArtifactPreviewSidebarEventDetail,
} from '@/components/chat/genui/widgets/ArtifactPreview'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }))

vi.mock('@/utils/error-handling', () => ({ logError: logErrorMock }))

const validMessageCompose = JSON.stringify({
  channel: 'message',
  title: 'Reply draft',
  variants: [{ label: 'Concise', body: 'Thanks, I will confirm.' }],
})

const artifact = {
  title: 'Snake game',
  description: 'An interactive game',
  source: { type: 'html' as const, html: '<main>Snake</main>' },
}

const validArtifactPreview = JSON.stringify(artifact)
const artifactPreviewListeners: EventListener[] = []

function setWindowWidth(width: number): void {
  vi.stubGlobal('innerWidth', width)
}

function renderArtifactPreview({ isStreaming }: { isStreaming: boolean }) {
  const listener = vi.fn<(event: Event) => void>()
  artifactPreviewListeners.push(listener)
  window.addEventListener(OPEN_ARTIFACT_PREVIEW_EVENT, listener)
  render(
    <GenUIToolCallRenderer
      isStreaming={isStreaming}
      toolCalls={[
        {
          id: 'artifact-1',
          name: 'render_artifact_preview',
          arguments: validArtifactPreview,
        },
      ]}
    />,
  )
  return listener
}

describe('GenUIToolCallRenderer', () => {
  beforeEach(() => {
    logErrorMock.mockReset()
    setWindowWidth(CONSTANTS.MOBILE_BREAKPOINT)
  })

  afterEach(() => {
    for (const listener of artifactPreviewListeners) {
      window.removeEventListener(OPEN_ARTIFACT_PREVIEW_EVENT, listener)
    }
    artifactPreviewListeners.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders completed widget arguments while the assistant stream continues', () => {
    render(
      <GenUIToolCallRenderer
        isStreaming
        toolCalls={[
          {
            id: 'tool-call-1',
            name: 'render_message_compose',
            arguments: validMessageCompose,
          },
        ]}
      />,
    )

    expect(screen.getByText('Reply draft')).toBeInTheDocument()
    expect(
      screen.queryByText(/Generating message compose/),
    ).not.toBeInTheDocument()
  })

  it('opens a generated artifact automatically on desktop', () => {
    const listener = renderArtifactPreview({ isStreaming: true })

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock
      .calls[0][0] as CustomEvent<ArtifactPreviewSidebarEventDetail>
    expect(event.detail).toEqual({
      action: 'open',
      artifact,
      toolCallId: 'artifact-1',
    })
  })

  it('does not auto-open generated artifacts on mobile', () => {
    setWindowWidth(CONSTANTS.MOBILE_BREAKPOINT - 1)
    const listener = renderArtifactPreview({ isStreaming: true })

    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps artifact card clicks as sidebar toggles', () => {
    const listener = renderArtifactPreview({ isStreaming: false })
    expect(listener).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Snake game/ }))

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock
      .calls[0][0] as CustomEvent<ArtifactPreviewSidebarEventDetail>
    expect(event.detail).toEqual({
      action: 'toggle',
      artifact,
      toolCallId: 'artifact-1',
    })
  })

  it('highlights only the open artifact and shows its full description', () => {
    const secondArtifact = {
      ...artifact,
      title: 'Second artifact',
      description:
        'A longer artifact description that should wrap across as many lines as needed.',
      source: { type: 'html' as const, html: '<main>Second</main>' },
    }
    const toolCalls = [
      {
        id: 'artifact-1',
        name: 'render_artifact_preview',
        arguments: validArtifactPreview,
      },
      {
        id: 'artifact-2',
        name: 'render_artifact_preview',
        arguments: JSON.stringify(secondArtifact),
      },
    ]
    const { rerender } = render(
      <GenUIToolCallRenderer
        isStreaming={false}
        activeArtifactToolCallId="artifact-2"
        toolCalls={toolCalls}
      />,
    )

    const firstButton = screen.getByRole('button', { name: /Snake game/ })
    const secondButton = screen.getByRole('button', {
      name: /Second artifact/,
    })
    const description = screen.getByText(secondArtifact.description)
    expect(firstButton).toHaveAttribute('aria-pressed', 'false')
    expect(secondButton).toHaveAttribute('aria-pressed', 'true')
    expect(secondButton.parentElement).toHaveClass('border-brand-accent-dark')
    expect(description).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(description).not.toHaveClass('truncate')

    rerender(
      <GenUIToolCallRenderer
        isStreaming={false}
        activeArtifactToolCallId="artifact-1"
        toolCalls={toolCalls}
      />,
    )
    expect(firstButton).toHaveAttribute('aria-pressed', 'true')
    expect(secondButton).toHaveAttribute('aria-pressed', 'false')
  })

  it('distinguishes identical artifacts by tool call', () => {
    expect(
      artifactPreviewTargetsEqual(
        artifact,
        'artifact-1',
        artifact,
        'artifact-2',
      ),
    ).toBe(false)
    expect(
      artifactPreviewTargetsEqual(
        artifact,
        'artifact-1',
        artifact,
        'artifact-1',
      ),
    ).toBe(true)
    expect(
      artifactPreviewTargetsEqual(
        artifact,
        'artifact-1',
        { ...artifact, description: 'Updated description' },
        'artifact-1',
      ),
    ).toBe(false)
  })

  it('shows a simple generating state without raw data or a character count', () => {
    const rawArguments = '{"source":{"type":"html","html":"private-markup"'
    render(
      <GenUIToolCallRenderer
        isStreaming
        toolCalls={[
          {
            id: 'tool-call-1',
            name: 'render_artifact_preview',
            arguments: rawArguments,
          },
        ]}
      />,
    )

    expect(screen.getByText(/Generating artifact preview/)).toBeInTheDocument()
    expect(screen.queryByText(/chars/)).not.toBeInTheDocument()
    expect(screen.queryByText(/private-markup/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /show stream/i }),
    ).not.toBeInTheDocument()
  })

  it('distinguishes invalid JSON, schema validation, and unknown widgets', () => {
    const { rerender } = render(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          { id: 'one', name: 'render_chart', arguments: '{"type":"bar"' },
        ]}
      />,
    )
    expect(
      screen.getByText('The component data is not valid JSON.'),
    ).toBeInTheDocument()

    rerender(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          {
            id: 'two',
            name: 'render_chart',
            arguments: '{"type":"invalid","data":[]}',
          },
        ]}
      />,
    )
    expect(screen.getByText(/failed schema validation/)).toBeInTheDocument()

    rerender(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[{ id: 'three', name: 'render_unknown', arguments: '{}' }]}
      />,
    )
    expect(screen.getByText('Component unavailable')).toBeInTheDocument()
  })

  it('shows schema-invalid complete JSON while continuation is streaming', () => {
    render(
      <GenUIToolCallRenderer
        isStreaming
        toolCalls={[
          {
            id: 'one',
            name: 'render_chart',
            arguments: '{"type":"invalid","data":[]}',
          },
        ]}
      />,
    )

    expect(screen.getByText(/failed schema validation/)).toBeInTheDocument()
    expect(screen.queryByText(/Generating chart/)).not.toBeInTheDocument()
  })

  it('keeps widget retry repeatable and exposes full regeneration separately', async () => {
    let rejectRetry!: (error: ArtifactRetryError) => void
    const retryWidget = vi
      .fn<(toolCallId: string) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetry = reject
          }),
      )
      .mockRejectedValue(new ArtifactRetryError('incomplete_replacement'))
    const regenerate = vi.fn()
    render(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          { id: 'one', name: 'render_chart', arguments: '{"type":"bar"' },
        ]}
        onRetryToolCall={retryWidget}
        onRetry={regenerate}
      />,
    )

    const retryButton = screen.getByRole('button', { name: 'Retry widget' })
    expect(retryButton).toHaveClass(
      'w-full',
      'bg-brand-accent-dark',
      'text-white',
      'md:w-auto',
    )
    expect(retryButton.parentElement).toHaveClass('flex-col', 'md:flex-row')
    expect(retryButton.parentElement?.parentElement).toHaveClass(
      'flex-col',
      'md:flex-row',
    )
    expect(
      screen.getByRole('button', { name: 'Regenerate response' }),
    ).toBeInTheDocument()
    fireEvent.click(retryButton)
    expect(retryWidget).toHaveBeenCalledExactlyOnceWith('one')
    const pendingRetry = screen.getByRole('button', {
      name: 'Fixing widget...',
    })
    const regenerateButton = screen.getByRole('button', {
      name: 'Regenerate response',
    })
    expect(pendingRetry).toBeDisabled()
    expect(regenerateButton).toBeDisabled()
    fireEvent.click(pendingRetry)
    fireEvent.click(regenerateButton)
    expect(retryWidget).toHaveBeenCalledOnce()
    expect(regenerate).not.toHaveBeenCalled()
    await act(async () => {
      rejectRetry(new ArtifactRetryError('incomplete_replacement'))
    })
    expect(
      screen.getByText(/replacement was incomplete or invalid JSON/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry widget' }))
    await waitFor(() => expect(retryWidget).toHaveBeenCalledTimes(2))
    expect(retryWidget).toHaveBeenNthCalledWith(2, 'one')
    expect(regenerate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate response' }))
    expect(regenerate).toHaveBeenCalledOnce()
  })

  it.each([
    ['request_failed', /Could not request a replacement/],
    ['schema_conversion_failed', /Could not prepare the component schema/],
    [
      'schema_invalid_replacement',
      /replacement did not match the component schema/,
    ],
    ['stale_target', /component changed while retrying/],
    ['unavailable_target', /component is no longer available to repair/],
  ] as const)('shows the %s retry category', async (code, description) => {
    render(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          { id: 'one', name: 'render_chart', arguments: '{"type":"bar"' },
        ]}
        onRetryToolCall={vi
          .fn()
          .mockRejectedValue(new ArtifactRetryError(code))}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry widget' }))
    expect(await screen.findByText(description)).toBeInTheDocument()
  })

  it('retries render exceptions and resets after arguments change', async () => {
    const widget = GENUI_WIDGETS_BY_NAME.render_message_compose
    const originalRender = widget.render
    const retryWidget = vi.fn()
    const regenerate = vi.fn()
    vi.spyOn(widget, 'render').mockImplementation(
      (args: { title?: string }, context: GenUIRenderContext) => {
        if (args.title === 'Reply draft') throw new Error('render failed')
        return originalRender!(args, context)
      },
    )

    function RenderExceptionHarness() {
      const [argumentsValue, setArgumentsValue] = useState(validMessageCompose)
      return (
        <GenUIToolCallRenderer
          isStreaming={false}
          toolCalls={[
            {
              id: 'tool-call-1',
              name: 'render_message_compose',
              arguments: argumentsValue,
            },
          ]}
          onRetry={regenerate}
          onRetryToolCall={async () => {
            retryWidget()
            if (retryWidget.mock.calls.length === 1) {
              throw new ArtifactRetryError('request_failed')
            }
            setArgumentsValue(
              JSON.stringify({
                channel: 'message',
                title: 'Recovered draft',
                variants: [{ label: 'Concise', body: 'Recovered.' }],
              }),
            )
            return true
          }}
        />
      )
    }

    render(<RenderExceptionHarness />)
    expect(
      screen.getByText(/component ran into a problem while rendering/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Regenerate response' }),
    ).toBeInTheDocument()
    expect(logErrorMock).toHaveBeenCalledTimes(1)
    expect(logErrorMock.mock.calls[0][1]).toMatchObject({
      message: 'render failed',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Retry widget' }))
    expect(
      await screen.findByText(/Could not request a replacement/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry widget' }))

    expect(await screen.findByText('Recovered draft')).toBeInTheDocument()
    expect(retryWidget).toHaveBeenCalledTimes(2)
    expect(regenerate).not.toHaveBeenCalled()
    expect(logErrorMock).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(
        screen.queryByText(/component ran into a problem while rendering/),
      ).not.toBeInTheDocument(),
    )
  })

  it('resets render failures when arguments change outside a retry', async () => {
    const widget = GENUI_WIDGETS_BY_NAME.render_message_compose
    const originalRender = widget.render
    vi.spyOn(widget, 'render').mockImplementation(
      (args: { title?: string }, context: GenUIRenderContext) => {
        if (args.title === 'Reply draft') throw new Error('render failed')
        return originalRender!(args, context)
      },
    )
    const toolCall = {
      id: 'external-repair',
      name: 'render_message_compose',
      arguments: validMessageCompose,
    }
    const { rerender } = render(
      <GenUIToolCallRenderer isStreaming={false} toolCalls={[toolCall]} />,
    )
    expect(
      screen.getByText(/component ran into a problem while rendering/),
    ).toBeInTheDocument()
    rerender(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          {
            ...toolCall,
            arguments: JSON.stringify({
              channel: 'message',
              title: 'External repair',
              variants: [{ label: 'Concise', body: 'Recovered.' }],
            }),
          },
        ]}
      />,
    )
    expect(await screen.findByText('External repair')).toBeInTheDocument()
    expect(
      screen.queryByText(/component ran into a problem while rendering/),
    ).not.toBeInTheDocument()
  })

  it('retries rendering when repaired arguments are unchanged', async () => {
    const widget = GENUI_WIDGETS_BY_NAME.render_message_compose
    const originalRender = widget.render
    let shouldThrow = true
    vi.spyOn(widget, 'render').mockImplementation(
      (args: { title?: string }, context: GenUIRenderContext) => {
        if (shouldThrow) throw new Error('render failed')
        return originalRender!(args, context)
      },
    )

    render(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          {
            id: 'tool-call-1',
            name: 'render_message_compose',
            arguments: validMessageCompose,
          },
        ]}
        onRetryToolCall={async () => {
          shouldThrow = false
          return true
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry widget' }))
    expect(await screen.findByText('Reply draft')).toBeInTheDocument()
  })

  it('classifies a null widget render as a retryable render failure', () => {
    const widget = GENUI_WIDGETS_BY_NAME.render_message_compose
    vi.spyOn(widget, 'render').mockReturnValue(null)

    render(
      <GenUIToolCallRenderer
        isStreaming={false}
        toolCalls={[
          {
            id: 'tool-call-1',
            name: 'render_message_compose',
            arguments: validMessageCompose,
          },
        ]}
        onRetryToolCall={vi.fn()}
      />,
    )

    expect(
      screen.getByText(/component ran into a problem while rendering/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Retry widget' }),
    ).toBeInTheDocument()
    expect(logErrorMock.mock.calls[0][1]).toMatchObject({
      message: 'Widget render returned null',
    })
    expect(logErrorMock.mock.calls[0][2]).toMatchObject({
      metadata: { failure: 'render_exception' },
    })
  })
})
