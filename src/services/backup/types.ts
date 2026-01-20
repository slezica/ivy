/**
 * Backup Sync Types
 *
 * Shared types for the sync system.
 */

// -----------------------------------------------------------------------------
// Backup Formats (what gets stored in Google Drive)
// -----------------------------------------------------------------------------

export interface BookBackup {
  id: string
  name: string
  duration: number
  position: number
  updated_at: number
  title: string | null
  artist: string | null
  artwork: string | null
  file_size: number
  fingerprint: string // base64-encoded
  hidden: boolean     // Soft-deleted (removed from library)
}

export interface ClipBackup {
  id: string
  source_id: string
  start: number
  duration: number
  note: string
  transcription: string | null
  created_at: number
  updated_at: number
}

// -----------------------------------------------------------------------------
// Sync Results and Status
// -----------------------------------------------------------------------------

export interface ConflictInfo {
  entityType: 'book' | 'clip'
  entityId: string
  resolution: string // human-readable description of how it was resolved
}

export interface SyncResult {
  uploaded: { books: number; clips: number }
  downloaded: { books: number; clips: number }
  deleted: { clips: number }
  conflicts: ConflictInfo[]
  errors: string[]
}

export interface SyncNotification {
  booksChanged: string[] // IDs of books that were modified by remote changes
  clipsChanged: string[] // IDs of clips that were modified by remote changes
}

export interface SyncStatus {
  isSyncing: boolean
  pendingCount: number
  error: string | null
}

export interface SyncListeners {
  onStatusChange?: (status: SyncStatus) => void
  onDataChange?: (notification: SyncNotification) => void
}
