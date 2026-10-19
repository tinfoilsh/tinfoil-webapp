/**
 * A 32-byte cryptographically random hex string (64 chars) generated once
 * at chat creation. Stored inside the chat's encrypted blob.
 */
export function generateCodeExecutionAccessToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
