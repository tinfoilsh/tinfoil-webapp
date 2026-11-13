export class BrowserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BrowserError'
  }
}

// An action whose input may have reached the page before it failed. It is
// not tried again: the task stops for the user to check the page.
export const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
export const outcomeUnknown = (cause?: unknown) =>
  new BrowserError(
    OUTCOME_UNKNOWN,
    'The action may have completed, but its result could not be verified. Check the page before continuing.',
    { cause },
  )

export function browserFailure(cause: unknown): {
  error: string
  message: string
} {
  return cause instanceof BrowserError
    ? { error: cause.code, message: cause.message }
    : {
        error: 'BROWSER_FAILED',
        message:
          'The browser action failed. Read the page before trying again.',
      }
}
