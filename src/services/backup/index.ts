/**
 * Backup Services
 *
 * Google Drive backup for books and clips.
 */

export { GoogleAuthService } from './auth'
export { GoogleDriveService } from './drive'
export type { DriveFile, BackupFolder } from './drive'
export { BackupSyncService } from './sync'
export { SyncQueueService } from './queue'
export type { QueueStats, ProcessResult, QueueItemHandler } from './queue'

// Types
export type {
  BookBackup,
  ClipBackup,
  SyncResult,
  SyncNotification,
  SyncStatus,
  SyncListeners,
  ConflictInfo,
} from './types'

// Pure functions (for testing)
export { mergeBook, mergeClip } from './merge'
export type { MergeResult } from './merge'
export { planSync } from './planner'
export type { SyncState, SyncPlan, RemoteBook, RemoteClip } from './planner'
