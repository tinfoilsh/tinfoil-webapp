import { deriveKeyIdHex } from '@/services/sync-enclave/key-bundle'
import {
  RECOVERY_ENVELOPE_EXPIRY_MS,
  type SyncedRecoveryEnvelope,
} from '@/types/chat-recovery'
import { uint8ArrayToBase64 } from '@/utils/binary-codec'
import {
  decodeRecoveryBase64,
  requireRecoveryId,
  requireRecoveryLowercaseHex,
  validateRecoveryEnvelope,
} from '@/utils/chat-recovery-envelope'

export { validateRecoveryEnvelope } from '@/utils/chat-recovery-envelope'

const AES_GCM = 'AES-GCM'
const HKDF = 'HKDF'
const SHA_256 = 'SHA-256'
const CEK_BYTES = 32
const NONCE_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const RECOVERY_TOKEN_HEX_LENGTH = 64
const SESSION_ID_HEX_LENGTH = 32
const KEY_ID_HEX_LENGTH = 32
const RECOVERY_ENVELOPE_VERSION = 1

export const RECOVERY_ENVELOPE_HKDF_INFO = 'tinfoil-chat-recovery-envelope-v1'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export type RecoveryTokenFields = {
  exportedSecret: string
  requestEnc: string
}

export type RecoveryTokenPayload = string | RecoveryTokenFields

export type RecoveryEnvelopePayload = {
  sessionId: string
  recoveryToken: RecoveryTokenPayload
}

export type EncryptRecoveryEnvelopeOptions = {
  cek: Uint8Array
  userId: string
  chatId: string
  turnId: string
  sessionId: string
  recoveryToken: RecoveryTokenPayload
  keyId?: string
  now?: Date | number
}

export type DecryptRecoveryEnvelopeOptions = {
  cek: Uint8Array
  userId: string
  chatId: string
  envelope: SyncedRecoveryEnvelope
  keyId?: string
  now?: Date | number
}

export type RewrapRecoveryEnvelopeOptions = {
  envelope: SyncedRecoveryEnvelope
  userId: string
  chatId: string
  oldCek: Uint8Array
  newCek: Uint8Array
  oldKeyId?: string
  newKeyId?: string
  now?: Date | number
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function validateRecoveryTokenFields(
  value: unknown,
): asserts value is RecoveryTokenFields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('chat recovery: recovery token must be an object')
  }
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields)
  if (
    keys.length !== 2 ||
    !keys.includes('exportedSecret') ||
    !keys.includes('requestEnc')
  ) {
    throw new Error(
      'chat recovery: recovery token must contain exactly exportedSecret and requestEnc',
    )
  }
  requireRecoveryLowercaseHex(
    fields.exportedSecret as string,
    RECOVERY_TOKEN_HEX_LENGTH,
    'recovery token exportedSecret',
  )
  requireRecoveryLowercaseHex(
    fields.requestEnc as string,
    RECOVERY_TOKEN_HEX_LENGTH,
    'recovery token requestEnc',
  )
}

function validateRecoveryToken(
  token: unknown,
): asserts token is RecoveryTokenPayload {
  if (typeof token === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(token)
    } catch {
      throw new Error(
        'chat recovery: serialized recovery token must be valid JSON',
      )
    }
    validateRecoveryTokenFields(parsed)
    return
  }
  validateRecoveryTokenFields(token)
}

function validatePayload(
  value: unknown,
): asserts value is RecoveryEnvelopePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('chat recovery: decrypted payload must be an object')
  }
  const payload = value as Record<string, unknown>
  const keys = Object.keys(payload)
  if (
    keys.length !== 2 ||
    !keys.includes('sessionId') ||
    !keys.includes('recoveryToken')
  ) {
    throw new Error(
      'chat recovery: decrypted payload must contain exactly sessionId and recoveryToken',
    )
  }
  requireRecoveryLowercaseHex(
    payload.sessionId as string,
    SESSION_ID_HEX_LENGTH,
    'sessionId',
  )
  validateRecoveryToken(payload.recoveryToken)
}

function aadBytes(
  userId: string,
  chatId: string,
  envelope: Pick<
    SyncedRecoveryEnvelope,
    'v' | 'turnId' | 'keyId' | 'createdAt' | 'expiresAt'
  >,
): Uint8Array {
  requireRecoveryId(userId, 'userId')
  requireRecoveryId(chatId, 'chatId')
  return textEncoder.encode(
    JSON.stringify([
      'tinfoil-chat-recovery-envelope-aad-v1',
      userId,
      chatId,
      envelope.turnId,
      envelope.keyId,
      envelope.v,
      envelope.createdAt,
      envelope.expiresAt,
    ]),
  )
}

async function deriveEnvelopeKey(cek: Uint8Array): Promise<CryptoKey> {
  if (cek.length !== CEK_BYTES) {
    throw new Error(`chat recovery: CEK must be ${CEK_BYTES} bytes`)
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(cek),
    HKDF,
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: HKDF,
      hash: SHA_256,
      salt: new Uint8Array(0),
      info: textEncoder.encode(RECOVERY_ENVELOPE_HKDF_INFO),
    },
    keyMaterial,
    { name: AES_GCM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function resolveKeyId(
  cek: Uint8Array,
  suppliedKeyId?: string,
): Promise<string> {
  const derivedKeyId = await deriveKeyIdHex(cek)
  if (suppliedKeyId !== undefined) {
    requireRecoveryLowercaseHex(suppliedKeyId, KEY_ID_HEX_LENGTH, 'keyId')
    if (suppliedKeyId !== derivedKeyId) {
      throw new Error('chat recovery: keyId does not match CEK')
    }
  }
  return derivedKeyId
}

function nowMilliseconds(now?: Date | number): number {
  const value = now instanceof Date ? now.getTime() : (now ?? Date.now())
  if (!Number.isFinite(value)) {
    throw new Error('chat recovery: now must be a valid timestamp')
  }
  return value
}

async function sealPayload(
  payload: RecoveryEnvelopePayload,
  cek: Uint8Array,
  userId: string,
  chatId: string,
  metadata: Pick<
    SyncedRecoveryEnvelope,
    'v' | 'turnId' | 'keyId' | 'createdAt' | 'expiresAt'
  >,
): Promise<SyncedRecoveryEnvelope> {
  validatePayload(payload)
  const key = await deriveEnvelopeKey(cek)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: AES_GCM,
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aadBytes(userId, chatId, metadata)),
      tagLength: AES_GCM_TAG_BYTES * 8,
    },
    key,
    textEncoder.encode(JSON.stringify(payload)),
  )
  const envelope: SyncedRecoveryEnvelope = {
    ...metadata,
    nonce: uint8ArrayToBase64(nonce),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
  }
  validateRecoveryEnvelope(envelope)
  return envelope
}

export async function encryptRecoveryEnvelope(
  options: EncryptRecoveryEnvelopeOptions,
): Promise<SyncedRecoveryEnvelope> {
  requireRecoveryId(options.turnId, 'turnId')
  const keyId = await resolveKeyId(options.cek, options.keyId)
  const createdAtMilliseconds = nowMilliseconds(options.now)
  const metadata = {
    v: RECOVERY_ENVELOPE_VERSION,
    turnId: options.turnId,
    keyId,
    createdAt: new Date(createdAtMilliseconds).toISOString(),
    expiresAt: new Date(
      createdAtMilliseconds + RECOVERY_ENVELOPE_EXPIRY_MS,
    ).toISOString(),
  } as const

  return sealPayload(
    {
      sessionId: options.sessionId,
      recoveryToken: options.recoveryToken,
    },
    options.cek,
    options.userId,
    options.chatId,
    metadata,
  )
}

export async function decryptRecoveryEnvelope(
  options: DecryptRecoveryEnvelopeOptions,
): Promise<RecoveryEnvelopePayload> {
  validateRecoveryEnvelope(options.envelope)
  const keyId = await resolveKeyId(options.cek, options.keyId)
  if (keyId !== options.envelope.keyId) {
    throw new Error('chat recovery: envelope keyId does not match CEK')
  }
  if (nowMilliseconds(options.now) >= Date.parse(options.envelope.expiresAt)) {
    throw new Error('chat recovery: envelope has expired')
  }

  const key = await deriveEnvelopeKey(options.cek)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: AES_GCM,
      iv: toArrayBuffer(decodeRecoveryBase64(options.envelope.nonce, 'nonce')),
      additionalData: toArrayBuffer(
        aadBytes(options.userId, options.chatId, options.envelope),
      ),
      tagLength: AES_GCM_TAG_BYTES * 8,
    },
    key,
    toArrayBuffer(
      decodeRecoveryBase64(options.envelope.ciphertext, 'ciphertext'),
    ),
  )

  let payload: unknown
  try {
    payload = JSON.parse(textDecoder.decode(plaintext))
  } catch {
    throw new Error('chat recovery: decrypted payload is invalid')
  }
  validatePayload(payload)
  return payload
}

export async function rewrapRecoveryEnvelope(
  options: RewrapRecoveryEnvelopeOptions,
): Promise<SyncedRecoveryEnvelope> {
  const payload = await decryptRecoveryEnvelope({
    cek: options.oldCek,
    keyId: options.oldKeyId,
    userId: options.userId,
    chatId: options.chatId,
    envelope: options.envelope,
    now: options.now,
  })
  const newKeyId = await resolveKeyId(options.newCek, options.newKeyId)
  return sealPayload(payload, options.newCek, options.userId, options.chatId, {
    v: RECOVERY_ENVELOPE_VERSION,
    turnId: options.envelope.turnId,
    keyId: newKeyId,
    createdAt: options.envelope.createdAt,
    expiresAt: options.envelope.expiresAt,
  })
}
