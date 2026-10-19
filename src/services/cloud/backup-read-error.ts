import type { PullItem } from '@/services/sync-enclave/sync-api'

export type CloudBackupReadCategory =
  | 'item_unavailable'
  | 'item_invalid'
  | 'key_unavailable'
  | 'snapshot_deleted'
  | 'snapshot_changed'

export class CloudBackupReadError extends Error {
  constructor(
    public readonly category: CloudBackupReadCategory,
    public readonly reason: string,
    public readonly omittable: boolean,
    options?: ErrorOptions,
  ) {
    super('Cloud backup source could not be read', options)
    this.name = 'CloudBackupReadError'
  }
}

export type CloudBackupProtocolErrorCode =
  | 'missing_item'
  | 'unexpected_item'
  | 'missing_etag'
  | 'invalid_etag'
  | 'invalid_previous_etag'

export class CloudBackupProtocolError extends Error {
  constructor(public readonly code: CloudBackupProtocolErrorCode) {
    super('Sync enclave returned an invalid backup pull response')
    this.name = 'CloudBackupProtocolError'
  }
}

/**
 * Settled result of one record inside a batched backup pull. Batch
 * responses stay positionally aligned with their requests so callers
 * can keep processing records in captured-inventory order.
 */
export type BackupPullResult<T> =
  { ok: true; value: T } | { ok: false; error: unknown }

export function unwrapBackupPullResult<T>(
  result: BackupPullResult<T> | undefined,
): T {
  if (!result) throw new CloudBackupProtocolError('missing_item')
  if (!result.ok) throw result.error
  return result.value
}

/**
 * Group a batched pull response by record ID. Request IDs must be
 * unique so one returned record can never satisfy two positional
 * results; every returned item must have been requested. Per-ID
 * duplicate detection is delegated to `validateBackupPullItem`,
 * which rejects multi-item buckets.
 */
export function groupBackupPullItems(
  items: PullItem[],
  requestedIds: readonly string[],
): Map<string, PullItem[]> {
  const requested = new Set(requestedIds)
  if (requested.size !== requestedIds.length)
    throw new CloudBackupProtocolError('unexpected_item')
  const grouped = new Map<string, PullItem[]>()
  for (const item of items) {
    if (!requested.has(item.id))
      throw new CloudBackupProtocolError('unexpected_item')
    const bucket = grouped.get(item.id)
    if (bucket) bucket.push(item)
    else grouped.set(item.id, [item])
  }
  return grouped
}

export function validateBackupPullItem(
  items: PullItem[],
  expectedId: string,
  expectedEtag: string,
): PullItem {
  if (items.length === 0) throw new CloudBackupProtocolError('missing_item')
  if (items.length !== 1 || items[0].id !== expectedId)
    throw new CloudBackupProtocolError('unexpected_item')
  const item = items[0]
  const hasEtag = Object.hasOwn(item, 'etag')
  const hasPreviousEtag = Object.hasOwn(item, 'previous_etag')
  if (
    hasEtag &&
    (typeof item.etag !== 'string' || item.etag.trim().length === 0)
  )
    throw new CloudBackupProtocolError('invalid_etag')
  if (
    hasPreviousEtag &&
    (typeof item.previous_etag !== 'string' ||
      item.previous_etag.trim().length === 0)
  )
    throw new CloudBackupProtocolError('invalid_previous_etag')

  if (item.ok) {
    if (!hasEtag) throw new CloudBackupProtocolError('missing_etag')
    if (item.etag === expectedEtag || item.previous_etag === expectedEtag)
      return item
    throw new CloudBackupReadError(
      'snapshot_changed',
      'record_changed_after_snapshot',
      true,
    )
  }

  const returnedEtags = [item.etag, item.previous_etag].filter(
    (etag): etag is string => etag !== undefined,
  )
  if (
    returnedEtags.length > 0 &&
    !returnedEtags.some((etag) => etag === expectedEtag)
  )
    throw new CloudBackupReadError(
      'snapshot_changed',
      'record_changed_after_snapshot',
      true,
    )
  if (returnedEtags.length === 0 && item.code !== 'NOT_FOUND')
    throw new CloudBackupProtocolError('missing_etag')
  if (item.code === 'NOT_FOUND')
    throw new CloudBackupReadError(
      'snapshot_deleted',
      'record_deleted_after_snapshot',
      true,
    )
  return item
}
