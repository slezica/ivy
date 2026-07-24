/**
 * Backup Sync Types
 *
 * Shared types for the sync system.
 */

// -----------------------------------------------------------------------------
// Backup Formats (what gets stored in Google Drive)
// -----------------------------------------------------------------------------

/**
 * Payload format versioning (both stamped into every uploaded JSON, both ≡ 1
 * when absent):
 *
 * - `version` — the exact format as-written. Bump on EVERY format change,
 *   additive ones included: it identifies the writer, letting readers tell
 *   "field absent because the writer predates it" from "field cleared".
 * - `version_compat` — the oldest reader that can safely interpret the
 *   payload. Bump only on breaking changes (renamed or reinterpreted fields).
 *   Readers reject payloads with version_compat above what they know
 *   (parseBackup in sync.ts) instead of misinterpreting them.
 */
// History: 1 = original format; 2 = book metadata extras (additive).
export const BACKUP_VERSION = 2
export const BACKUP_VERSION_COMPAT = 1

export interface BookBackup {
  version?: number         // Format as-written (absent ≡ 1)
  version_compat?: number  // Oldest reader that can interpret this (absent ≡ 1)
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
  // Metadata extras (additive, absent in legacy backups — read as null)
  summary?: string | null
  narrator?: string | null
  series?: string | null
  part?: string | null
  subtitle?: string | null
  date?: string | null
  language?: string | null
  metadata_version?: number | null // Extractor version that produced the extras
  deleted?: boolean   // Tombstone marker (full payload + deleted: true)
  merged_into?: string // Identity retirement: this id merged into the given (smaller) book id
}

export interface ClipBackup {
  version?: number         // Format as-written (absent ≡ 1)
  version_compat?: number  // Oldest reader that can interpret this (absent ≡ 1)
  id: string
  source_id: string
  start: number
  duration: number
  note: string
  transcription: string | null
  source_title?: string | null   // Book title snapshot (absent in legacy backups)
  source_artist?: string | null  // Book artist snapshot (absent in legacy backups)
  created_at: number
  updated_at: number
  updated_by: string | null  // device ID (null for legacy backups)
  deleted?: boolean          // Tombstone marker (full payload + deleted: true)
}

export interface SessionBackup {
  version?: number         // Format as-written (absent ≡ 1)
  version_compat?: number  // Oldest reader that can interpret this (absent ≡ 1)
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
