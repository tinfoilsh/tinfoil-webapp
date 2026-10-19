export const PERFORMANCE_METRICS = {
  AUTH_RESTORATION: 'tinfoil.auth.restoration',
  CONFIG_READY: 'tinfoil.config.ready',
  INFERENCE_ATTESTATION: 'tinfoil.inference.attestation',
  INFERENCE_SESSION_TOKEN: 'tinfoil.inference.session-token',
  INFERENCE_STREAM_READY: 'tinfoil.inference.stream-ready',
} as const

export function startPerformanceTimer(): number | null {
  return typeof performance === 'undefined' ? null : performance.now()
}

export function recordPerformanceDuration(
  name: (typeof PERFORMANCE_METRICS)[keyof typeof PERFORMANCE_METRICS],
  startedAt: number | null,
): void {
  if (startedAt === null || typeof performance === 'undefined') return
  try {
    performance.measure(name, {
      start: startedAt,
      end: performance.now(),
    })
  } catch {
    // best-effort
  }
}
