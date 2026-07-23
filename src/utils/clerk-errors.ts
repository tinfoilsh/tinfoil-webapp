export function getClerkErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'errors' in error &&
    Array.isArray(error.errors)
  ) {
    const firstError = error.errors[0]
    if (
      typeof firstError === 'object' &&
      firstError !== null &&
      'longMessage' in firstError &&
      typeof firstError.longMessage === 'string'
    ) {
      return firstError.longMessage
    }
    if (
      typeof firstError === 'object' &&
      firstError !== null &&
      'message' in firstError &&
      typeof firstError.message === 'string'
    ) {
      return firstError.message
    }
  }

  if (typeof error === 'object' && error !== null) {
    if ('longMessage' in error && typeof error.longMessage === 'string') {
      return error.longMessage
    }
    if ('message' in error && typeof error.message === 'string') {
      return error.message
    }
  }

  return fallback
}
