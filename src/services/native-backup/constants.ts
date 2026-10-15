export const NATIVE_BACKUP_FORMAT = 'tinfoil-native-backup' as const
export const NATIVE_BACKUP_VERSION = 1 as const
export const NATIVE_BACKUP_VERSION_V2 = 2 as const

export const NATIVE_BACKUP_LIMITS = {
  archiveBytes: 512 * 1024 * 1024,
  entries: 50_000,
  entities: 100_000,
  discoveredRecords: 100_000,
  omissions: 100_000,
  localInventoryAttempts: 3,
  messages: 2_000_000,
  attachments: 100_000,
  imageBytes: 32 * 1024 * 1024,
  aggregateJsonBytes: 256 * 1024 * 1024,
} as const

export const NATIVE_BACKUP_ENTITY_KINDS = [
  'projects',
  'project_documents',
  'cloud_chats',
  'local_chats',
  'relationships',
  'images',
] as const

export type NativeBackupEntityKind = (typeof NATIVE_BACKUP_ENTITY_KINDS)[number]
