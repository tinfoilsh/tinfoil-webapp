import { DEV_ENABLE_DEBUG_LOGS } from '@/constants/storage-keys'

/**
 * Logging helpers that print to the dev console only. By design, nothing
 * here ever leaves the user's browser — Tinfoil's privacy model forbids
 * shipping logs, errors, or telemetry to any third party.
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug'

interface ErrorContext {
  component?: string
  action?: string
  userId?: string
  metadata?: Record<string, unknown>
}

/**
 * Reading localStorage can throw in restricted environments (blocked
 * site data, sandboxed frames). Loggers run inside catch blocks, so
 * they must never throw themselves.
 */
function debugLogsEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(DEV_ENABLE_DEBUG_LOGS) === 'true'
  } catch {
    return false
  }
}

/**
 * Log an error with context - replace console.error calls with this
 */
export function logError(
  message: string,
  error?: Error | unknown,
  context?: ErrorContext,
): void {
  const debugEnabled = debugLogsEnabled()

  // Log in development, or in production when the user opted in via the
  // local debug flag (see logInfo). Output never leaves the browser —
  // Tinfoil's privacy model forbids shipping user data (or anything that
  // could deanonymize a user) to a third-party logging service, so no
  // remote logging is wired up here; otherwise errors are silently dropped.
  if (process.env.NODE_ENV === 'development' || debugEnabled) {
    // Extract error message without passing Error object to avoid triggering Next.js error overlay
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.warn(
      `[${context?.component || 'Unknown'}] ${message}: ${errorMessage}`,
    )
    // Only log stack trace if debug logs are enabled
    if (debugEnabled && error instanceof Error) {
      console.log('Stack trace:', error.stack)
    }
  }
}

/**
 * Log a warning - replace console.warn calls with this
 */
export function logWarning(message: string, context?: ErrorContext): void {
  const debugEnabled = debugLogsEnabled()

  if (process.env.NODE_ENV === 'development' || debugEnabled) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
    console.warn(
      `[${timestamp}] [${context?.component || 'Unknown'}] ${message}`,
      context?.metadata || '',
    )
  }
}

/**
 * In a production build, info logs are off by default. Power users can opt
 * in from their own DevTools console (the toggle is purely client-side):
 *   localStorage.setItem('tinfoil-dev-enable-debug-logs', 'true')
 *   localStorage.removeItem('tinfoil-dev-enable-debug-logs')
 */
export function logInfo(message: string, context?: ErrorContext): void {
  const debugEnabled = debugLogsEnabled()

  if (process.env.NODE_ENV === 'development' || debugEnabled) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
    console.log(
      `[${timestamp}] [${context?.component || 'Unknown'}] ${message}`,
      context?.metadata || '',
    )
  }
}

/**
 * Handle and log errors with user-friendly fallback
 */
export function handleError(
  error: Error | unknown,
  fallbackMessage: string,
  context?: ErrorContext,
): string {
  logError(fallbackMessage, error, context)

  // Return user-friendly message
  if (error instanceof Error) {
    return error.message || fallbackMessage
  }

  return fallbackMessage
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
