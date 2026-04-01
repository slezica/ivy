import { BaseService } from './base'
import { AudioSlicerService, AudioPlayerService, AudioMetadataService, ChapterReaderService, playbackService } from './audio'
import { DatabaseService, FileStorageService, FileCopierService, FileDownloaderService, FilePickerService } from './storage'
import { WhisperService, TranscriptionQueueService } from './transcription'
import { SharingService } from './system'
import { GoogleAuthService, GoogleDriveService, BackupSyncService } from './backup'

export type {
  BaseService,
  AudioSlicerService,
  DatabaseService,
  AudioPlayerService,
  AudioMetadataService,
  ChapterReaderService,
  WhisperService,
  FileStorageService,
  FileCopierService,
  FileDownloaderService,
  FilePickerService,
  TranscriptionQueueService,
  SharingService,
  playbackService,
  GoogleAuthService,
  GoogleDriveService,
  BackupSyncService,
}

export type {
  PlayerStatus,
  PlaybackStatus,
  AudioPlayerEvents,
  TrackMetadata,
  AudioMetadata,
  SliceOptions,
  SliceResult,
} from './audio'


export type {
  CopyBeginResult,
  CopyCommitResult,
  ProgressCallback,
  DownloadResult,
  DownloadProgressCallback,
} from './storage'

export type {
  Book,
  Chapter,
  Clip,
  ClipWithFile,
  Session,
  SessionWithBook,
  Settings,
  SyncEntityType,
  SyncOperation,
  SyncManifestEntry,
  SyncOutboxItem,
  SyncCheckpoint,
  PickedFile
} from './storage'

// Minimal type for action deps that queue sync changes
export interface SyncQueueService {
  queueChange(entityType: 'book' | 'clip' | 'session', entityId: string, operation: 'upsert' | 'delete', entityUpdatedAt?: number): Promise<void>
  getCount(maxAttempts?: number): Promise<number>
}


export type {
  TranscriptionQueueDeps,
  TranscriptionQueueEvents,
} from './transcription'


export type {
  DriveFile,
  BackupFolder,
  BookBackup,
  ClipBackup,
  SyncResult,
  SyncNotification,
  SyncStatus,
  BackupSyncEvents,
} from './backup'


export const db = new DatabaseService()
export const files = new FileStorageService()
export const copier = new FileCopierService()
export const downloader = new FileDownloaderService()
export const picker = new FilePickerService()
export const metadata = new AudioMetadataService()
export const chapters = new ChapterReaderService()
export const slicer = new AudioSlicerService()
export const whisper = new WhisperService()
export const sharing = new SharingService()
export const audio = new AudioPlayerService()
export const auth = new GoogleAuthService()
export const drive = new GoogleDriveService(auth)
export const sync = new BackupSyncService(db, drive, auth)
export const transcription = new TranscriptionQueueService({ database: db, whisper, slicer })

