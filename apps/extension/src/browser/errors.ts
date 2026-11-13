export class BrowserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BrowserError'
  }
}

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
