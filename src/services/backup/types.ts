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
  speed?: number      // Playback speed as integer percentage (100 = 1.0x). Optional for backward compat.
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

export interface SessionBackup {
  id: string
  book_id: string
  started_at: number
  ended_at: number
  updated_at: number
}

// -----------------------------------------------------------------------------
// Sync Results and Status
// -----------------------------------------------------------------------------

export interface ConflictInfo {
  entityType: 'book' | 'clip' | 'session'
  entityId: string
  resolution: string // human-readable description of how it was resolved
}

export interface SyncResult {
  uploaded: { books: number; clips: number; sessions: number }
  downloaded: { books: number; clips: number; sessions: number }
  deleted: { clips: number; sessions: number }
  conflicts: ConflictInfo[]
  errors: string[]
}

export interface SyncNotification {
  booksChanged: string[] // IDs of books that were modified by remote changes
  clipsChanged: string[] // IDs of clips that were modified by remote changes
  sessionsChanged: string[] // IDs of sessions that were modified by remote changes
}

export interface SyncStatus {
  isSyncing: boolean
  pendingCount: number
  error: string | null
}
