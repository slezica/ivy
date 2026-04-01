/**
 * Backup Services
 *
 * Google Drive backup for books, clips, and sessions.
 */

export { GoogleAuthService } from './auth'
export { GoogleDriveService } from './drive'
export type { DriveFile, BackupFolder } from './drive'
export { BackupSyncService } from './sync'
export type { BackupSyncEvents } from './sync'

// Types
export type {
  BookBackup,
  ClipBackup,
  SessionBackup,
  SyncResult,
  SyncNotification,
  SyncStatus,
} from './types'
