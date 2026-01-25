// =============================================================================
// Audio
// =============================================================================

export { AudioPlayerService } from './audio'
export type { PlayerStatus, PlaybackStatus, AudioPlayerListeners, TrackMetadata } from './audio'

export { playbackService } from './audio'

export { AudioMetadataService } from './audio'
export type { AudioMetadata } from './audio'

export { AudioSlicerService } from './audio'
export type { SliceOptions, SliceResult } from './audio'

// =============================================================================
// Storage
// =============================================================================

export { DatabaseService } from './storage'
export type { Book, Clip, ClipWithFile, Session, SessionWithBook, Settings, SyncEntityType, SyncOperation, SyncManifestEntry, SyncQueueItem } from './storage'

export { FileStorageService } from './storage'

export { FilePickerService } from './storage'
export type { PickedFile } from './storage'

// =============================================================================
// Transcription
// =============================================================================

export { WhisperService } from './transcription'

export { TranscriptionQueueService } from './transcription'
export type { TranscriptionCallback, TranscriptionQueueDeps } from './transcription'

// =============================================================================
// System
// =============================================================================

export { SharingService } from './system'

// =============================================================================
// Backup
// =============================================================================

export { GoogleAuthService, GoogleDriveService, BackupSyncService, SyncQueueService } from './backup'
export type { DriveFile, BackupFolder, BookBackup, ClipBackup, SyncResult, SyncNotification, SyncStatus, SyncListeners, QueueStats } from './backup'
