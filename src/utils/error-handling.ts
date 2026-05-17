import { DEV_ENABLE_DEBUG_LOGS } from '@/constants/storage-keys'

/**
 * Error handling utilities for production-ready logging
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug'

interface ErrorContext {
  component?: string
  action?: string
  userId?: string
  metadata?: Record<string, unknown>
}

/**
 * Log an error with context - replace console.error calls with this
 */
export function logError(
  message: string,
  error?: Error | unknown,
  context?: ErrorContext,
): void {
  // In development, still log to console for debugging
  if (process.env.NODE_ENV === 'development') {
    // Extract error message without passing Error object to avoid triggering Next.js error overlay
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.warn(
      `[${context?.component || 'Unknown'}] ${message}: ${errorMessage}`,
    )
    // Only log stack trace if debug logs are enabled
    if (
      typeof window !== 'undefined' &&
      localStorage.getItem(DEV_ENABLE_DEBUG_LOGS) === 'true' &&
      error instanceof Error
    ) {
      console.log('Stack trace:', error.stack)
    }
    return
  }

  // In production, errors are silently dropped. Tinfoil's privacy model
  // forbids shipping user data (or anything that could deanonymize a user) to
  // a third-party logging service, so no remote logging is wired up here.
}

/**
 * Log a warning - replace console.warn calls with this
 */
export function logWarning(message: string, context?: ErrorContext): void {
  const debugEnabled =
    typeof window !== 'undefined' &&
    localStorage.getItem(DEV_ENABLE_DEBUG_LOGS) === 'true'

  if (process.env.NODE_ENV === 'development' || debugEnabled) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
    console.warn(
      `[${timestamp}] [${context?.component || 'Unknown'}] ${message}`,
      context?.metadata || '',
    )
  }
}

/**
 * Log info - replace console.log calls with this
 *
 * To enable in production, run in browser console:
 * localStorage.setItem('tinfoil-dev-enable-debug-logs', 'true')
 *
 * To disable:
 * localStorage.removeItem('tinfoil-dev-enable-debug-logs')
 */
export function logInfo(message: string, context?: ErrorContext): void {
  const debugEnabled =
    typeof window !== 'undefined' &&
    localStorage.getItem(DEV_ENABLE_DEBUG_LOGS) === 'true'

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
