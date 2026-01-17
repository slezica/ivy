// =============================================================================
// Audio
// =============================================================================

export { AudioPlayerService, audioPlayerService } from './audio'
export type { PlayerStatus, PlaybackStatus, AudioPlayerListeners, TrackMetadata } from './audio'

export { playbackService } from './audio'

export { AudioMetadataService, audioMetadataService } from './audio'
export type { AudioMetadata } from './audio'

export { AudioSlicerService, audioSlicerService } from './audio'
export type { SliceOptions, SliceResult } from './audio'

// =============================================================================
// Storage
// =============================================================================

export { DatabaseService, databaseService } from './storage'
export type { Book, Clip, ClipWithFile, Session } from './storage'

export { FileStorageService, fileStorageService } from './storage'

export { FilePickerService, filePickerService } from './storage'
export type { PickedFile } from './storage'

// =============================================================================
// Transcription
// =============================================================================

export { WhisperService, whisperService } from './transcription'

export { TranscriptionQueueService, transcriptionService } from './transcription'
export type { TranscriptionCallback, TranscriptionQueueDeps } from './transcription'

// =============================================================================
// System
// =============================================================================

export { SharingService } from './system'

// =============================================================================
// Backup
// =============================================================================

export { googleAuthService, googleDriveService, backupSyncService } from './backup'
export type { DriveFile, BackupFolder, BookBackup, ClipBackup, SyncResult } from './backup'
