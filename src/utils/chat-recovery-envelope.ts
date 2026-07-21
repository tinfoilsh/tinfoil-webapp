import {
  MAX_RECOVERY_CIPHERTEXT_BYTES,
  MAX_RECOVERY_ID_LENGTH,
  RECOVERY_ENVELOPE_EXPIRY_MS,
  type PendingRecoveryEnvelope,
} from '@/types/chat-recovery'
import { base64ToUint8Array } from './binary-codec'

const AES_GCM_TAG_BYTES = 16
const NONCE_BYTES = 12
const NONCE_BASE64_LENGTH = 16
const MAX_RECOVERY_CIPHERTEXT_BASE64_LENGTH =
  Math.ceil(MAX_RECOVERY_CIPHERTEXT_BYTES / 3) * 4
const RECOVERY_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function requireRecoveryId(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.length > MAX_RECOVERY_ID_LENGTH
  ) {
    throw new Error(
      `chat recovery: ${name} must be between 1 and ${MAX_RECOVERY_ID_LENGTH} characters`,
    )
  }
}

export function requireRecoveryLowercaseHex(
  value: string,
  length: number,
  name: string,
): void {
  if (
    typeof value !== 'string' ||
    value.length !== length ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw new Error(
      `chat recovery: ${name} must be ${length} lowercase hexadecimal characters`,
    )
  }
}

function requireTimestamp(value: string, name: string): number {
  if (typeof value !== 'string' || !RECOVERY_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`chat recovery: ${name} must be a timestamp`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new Error(`chat recovery: ${name} must be a valid timestamp`)
  }
  return timestamp
}

export function decodeRecoveryBase64(
  value: string,
  name: string,
  maxEncodedLength = MAX_RECOVERY_CIPHERTEXT_BASE64_LENGTH,
): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxEncodedLength ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(`chat recovery: ${name} must be base64`)
  }

  try {
    return base64ToUint8Array(value)
  } catch {
    throw new Error(`chat recovery: ${name} must be base64`)
  }
}

export function validateRecoveryEnvelope(
  envelope: PendingRecoveryEnvelope,
): void {
  if (typeof envelope !== 'object' || envelope === null || envelope.v !== 1) {
    throw new Error('chat recovery: envelope version must be 1')
  }
  requireRecoveryId(envelope.turnId, 'turnId')
  requireRecoveryLowercaseHex(envelope.keyId, 32, 'keyId')

  const createdAt = requireTimestamp(envelope.createdAt, 'createdAt')
  const expiresAt = requireTimestamp(envelope.expiresAt, 'expiresAt')
  const lifetime = expiresAt - createdAt
  if (lifetime <= 0 || lifetime > RECOVERY_ENVELOPE_EXPIRY_MS) {
    throw new Error('chat recovery: envelope lifetime is invalid')
  }

  const nonce = decodeRecoveryBase64(
    envelope.nonce,
    'nonce',
    NONCE_BASE64_LENGTH,
  )
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`chat recovery: nonce must decode to ${NONCE_BYTES} bytes`)
  }
  const ciphertext = decodeRecoveryBase64(envelope.ciphertext, 'ciphertext')
  if (
    ciphertext.length <= AES_GCM_TAG_BYTES ||
    ciphertext.length > MAX_RECOVERY_CIPHERTEXT_BYTES
  ) {
    throw new Error('chat recovery: ciphertext length is invalid')
  }
}
