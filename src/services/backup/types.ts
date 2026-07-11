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
  updated_by: string | null  // device ID (null for legacy backups)
  title: string | null
  artist: string | null
  artwork: string | null
  file_size: number
  fingerprint: string // base64-encoded
  speed?: number      // Playback speed as integer percentage (100 = 1.0x). Optional for backward compat.
  deleted?: boolean   // Tombstone marker (full payload + deleted: true)
  merged_into?: string // Identity retirement: this id merged into the given (smaller) book id
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
  updated_by: string | null  // device ID (null for legacy backups)
  deleted?: boolean          // Tombstone marker (full payload + deleted: true)
}

export interface SessionBackup {
  id: string
  book_id: string
  started_at: number
  ended_at: number
  updated_at: number
  updated_by: string | null  // device ID (null for legacy backups)
  deleted?: boolean          // Tombstone marker (full payload + deleted: true)
}

// -----------------------------------------------------------------------------
// Sync Results and Status
// -----------------------------------------------------------------------------

export interface SyncResult {
  uploaded: { books: number; clips: number; sessions: number }
  downloaded: { books: number; clips: number; sessions: number }
  deleted: { clips: number; sessions: number }
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
  failingCount: number  // Repeatedly failing items (push attempts >= 3 + pull quarantined) — still retried
  error: string | null
}
