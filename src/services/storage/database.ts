/**
 * Database Service
 *
 * SQLite operations for files, clips, and sessions.
 * Single source of truth for persistent app data.
 */

import * as SQLite from 'expo-sqlite'

import { generateId } from '../../utils'

// =============================================================================
// Public Interface
// =============================================================================

export interface Book {
  id: string               // UUID primary key
  uri: string | null       // Local file:// path (null if archived)
  name: string
  duration: number         // milliseconds
  position: number         // milliseconds (resume position)
  updated_at: number       // timestamp (last position update or modification)
  title: string | null
  artist: string | null
  artwork: string | null   // base64 data URI
  file_size: number        // File size in bytes (for fingerprint matching)
  fingerprint: Uint8Array  // First 4KB of file (BLOB)
}

export interface Clip {
  id: string
  source_id: string        // References files.id (parent file)
  uri: string              // Clip's own audio file
  start: number            // milliseconds
  duration: number         // milliseconds
  note: string
  transcription: string | null  // Auto-generated from audio
  created_at: number
  updated_at: number
}

export interface ClipWithFile extends Clip {
  file_uri: string | null    // Source file URI (null if removed)
  file_name: string
  file_title: string | null
  file_artist: string | null
  file_duration: number
}

export interface Session {
  id: string
  file_uri: string
  start: number
  duration: number
  created_at: number
  updated_at: number
}

export interface Settings {
  sync_enabled: boolean
}

// Sync-related interfaces
export type SyncEntityType = 'book' | 'clip'
export type SyncOperation = 'upsert' | 'delete'

export interface SyncManifestEntry {
  entity_type: SyncEntityType
  entity_id: string
  local_updated_at: number | null   // Local timestamp at last sync
  remote_updated_at: number | null  // Remote timestamp at last sync
  remote_file_id: string | null     // Drive file ID (JSON)
  remote_mp3_file_id: string | null // Drive file ID (MP3, clips only)
  synced_at: number
}

export interface SyncQueueItem {
  id: string
  entity_type: SyncEntityType
  entity_id: string
  operation: SyncOperation
  queued_at: number
  attempts: number
  last_error: string | null
}

// =============================================================================
// Service
// =============================================================================

export class DatabaseService {
  private db: SQLite.SQLiteDatabase

  constructor() {
    this.db = SQLite.openDatabaseSync('audioplayer.db')
    this.initialize()
  }

  // ---------------------------------------------------------------------------
  // Books
  // ---------------------------------------------------------------------------

  getBookByUri(uri: string): Book | null {
    const result = this.db.getFirstSync<Book>(
      'SELECT * FROM files WHERE uri = ?',
      [uri]
    )
    return result || null
  }

  getBookById(id: string): Book | null {
    const result = this.db.getFirstSync<Book>(
      'SELECT * FROM files WHERE id = ?',
      [id]
    )
    return result || null
  }

  getBookByFingerprint(fileSize: number, fingerprint: Uint8Array): Book | null {
    const result = this.db.getFirstSync<Book>(
      'SELECT * FROM files WHERE file_size = ? AND fingerprint = ?',
      [fileSize, fingerprint]
    )
    return result || null
  }

  /**
   * Find a Book by URI - either the book's own URI or one of its clip URIs.
   * Useful for playback where the URI could be a book or a clip's audio file.
   */
  getBookByAnyUri(uri: string): Book | null {
    // First try direct book lookup
    const book = this.getBookByUri(uri)
    if (book) return book

    // Try to find a clip with this URI and return its source book
    const result = this.db.getFirstSync<Book>(
      `SELECT files.* FROM files
       INNER JOIN clips ON clips.source_id = files.id
       WHERE clips.uri = ?`,
      [uri]
    )
    return result || null
  }

  getAllBooks(): Book[] {
    return this.db.getAllSync<Book>(
      'SELECT * FROM files ORDER BY updated_at DESC'
    )
  }

  upsertBook(
    id: string,
    uri: string,
    name: string,
    duration: number | null,
    position: number,
    title?: string | null,
    artist?: string | null,
    artwork?: string | null,
    fileSize?: number,
    fingerprint?: Uint8Array
  ): Book {
    const now = Date.now()
    const existing = this.getBookById(id)

    if (existing) {
      this.db.runSync(
        'UPDATE files SET uri = ?, name = ?, duration = ?, position = ?, updated_at = ?, title = ?, artist = ?, artwork = ?, file_size = ?, fingerprint = ? WHERE id = ?',
        [uri, name, duration, position, now, title ?? null, artist ?? null, artwork ?? null, fileSize ?? null, fingerprint ?? null, id]
      )
      return this.getBookById(id)!
    } else {
      this.db.runSync(
        'INSERT INTO files (id, uri, name, duration, position, updated_at, title, artist, artwork, file_size, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, uri, name, duration, position, now, title ?? null, artist ?? null, artwork ?? null, fileSize ?? null, fingerprint ?? null]
      )
      return this.getBookById(id)!
    }
  }

  /**
   * Restore an archived book by attaching a new file.
   * Preserves position, updates uri and metadata, refreshes updated_at.
   */
  restoreBook(
    id: string,
    uri: string,
    name: string,
    duration: number,
    title: string | null,
    artist: string | null,
    artwork: string | null
  ): Book {
    const now = Date.now()
    this.db.runSync(
      'UPDATE files SET uri = ?, name = ?, duration = ?, updated_at = ?, title = ?, artist = ?, artwork = ? WHERE id = ?',
      [uri, name, duration, now, title, artist, artwork, id]
    )
    return this.getBookById(id)!
  }

  /**
   * Touch an existing book to update updated_at timestamp.
   */
  touchBook(id: string): void {
    const now = Date.now()
    this.db.runSync(
      'UPDATE files SET updated_at = ? WHERE id = ?',
      [now, id]
    )
  }

  updateBookPosition(id: string, position: number): void {
    try {
      const now = Date.now()
      this.db.runSync(
        'UPDATE files SET position = ?, updated_at = ? WHERE id = ?',
        [position, now, id]
      )
    } catch (error) {
      // Silently ignore during app transitions/resets
      console.debug('Failed to update book position (non-critical):', error)
    }
  }

  archiveBook(id: string): void {
    this.db.runSync(
      'UPDATE files SET uri = NULL WHERE id = ?',
      [id]
    )
  }

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------

  getClip(id: string): Clip | null {
    const result = this.db.getFirstSync<Clip>(
      'SELECT * FROM clips WHERE id = ?',
      [id]
    )
    return result || null
  }

  getClipsForBook(bookId: string): Clip[] {
    return this.db.getAllSync<Clip>(
      'SELECT * FROM clips WHERE source_id = ? ORDER BY start ASC',
      [bookId]
    )
  }

  getAllClips(): ClipWithFile[] {
    return this.db.getAllSync<ClipWithFile>(
      `SELECT
        clips.*,
        files.uri as file_uri,
        files.name as file_name,
        files.title as file_title,
        files.artist as file_artist,
        files.duration as file_duration
      FROM clips
      INNER JOIN files ON clips.source_id = files.id
      ORDER BY clips.created_at DESC`
    )
  }

  createClip(id: string, sourceId: string, uri: string, start: number, duration: number, note: string): Clip {
    const now = Date.now()
    this.db.runSync(
      'INSERT INTO clips (id, source_id, uri, start, duration, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, sourceId, uri, start, duration, note, now, now]
    )

    return {
      id,
      source_id: sourceId,
      uri,
      start,
      duration,
      note,
      transcription: null,
      created_at: now,
      updated_at: now,
    }
  }

  updateClip(id: string, updates: { note?: string; start?: number; duration?: number; uri?: string; transcription?: string }): void {
    const now = Date.now()
    const setClauses: string[] = ['updated_at = ?']
    const values: (string | number)[] = [now]

    if (updates.note !== undefined) {
      setClauses.push('note = ?')
      values.push(updates.note)
    }
    if (updates.start !== undefined) {
      setClauses.push('start = ?')
      values.push(updates.start)
    }
    if (updates.duration !== undefined) {
      setClauses.push('duration = ?')
      values.push(updates.duration)
    }
    if (updates.uri !== undefined) {
      setClauses.push('uri = ?')
      values.push(updates.uri)
    }
    if (updates.transcription !== undefined) {
      setClauses.push('transcription = ?')
      values.push(updates.transcription)
    }

    values.push(id)
    this.db.runSync(
      `UPDATE clips SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    )
  }

  getClipsNeedingTranscription(): Clip[] {
    return this.db.getAllSync<Clip>(
      'SELECT * FROM clips WHERE transcription IS NULL ORDER BY created_at ASC'
    )
  }

  deleteClip(id: string): void {
    this.db.runSync('DELETE FROM clips WHERE id = ?', [id])
  }

  // ---------------------------------------------------------------------------
  // Backup / Restore
  // ---------------------------------------------------------------------------

  /**
   * Restore a book from backup. Inserts if new, updates if exists and newer.
   * Does not set uri (file path) - caller must handle file restoration separately.
   */
  restoreBookFromBackup(
    id: string,
    name: string,
    duration: number,
    position: number,
    updated_at: number,
    title: string | null,
    artist: string | null,
    artwork: string | null,
    fileSize: number,
    fingerprint: Uint8Array
  ): void {
    const existing = this.getBookById(id)

    if (existing) {
      // Only update if backup is newer
      if (updated_at > existing.updated_at) {
        this.db.runSync(
          `UPDATE files SET name = ?, duration = ?, position = ?, updated_at = ?,
           title = ?, artist = ?, artwork = ?, file_size = ?, fingerprint = ?
           WHERE id = ?`,
          [name, duration, position, updated_at, title, artist, artwork, fileSize, fingerprint, id]
        )
      }
    } else {
      // Insert with specific ID (SQLite allows this even with AUTOINCREMENT)
      this.db.runSync(
        `INSERT INTO files (id, uri, name, duration, position, updated_at, title, artist, artwork, file_size, fingerprint)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, duration, position, updated_at, title, artist, artwork, fileSize, fingerprint]
      )
    }
  }

  /**
   * Restore a clip from backup. Inserts if new, updates if exists and newer.
   */
  restoreClipFromBackup(
    id: string,
    sourceId: string,
    uri: string,
    start: number,
    duration: number,
    note: string,
    transcription: string | null,
    created_at: number,
    updated_at: number
  ): void {
    const existing = this.getClip(id)

    if (existing) {
      // Only update if backup is newer
      if (updated_at > existing.updated_at) {
        this.db.runSync(
          `UPDATE clips SET source_id = ?, uri = ?, start = ?, duration = ?,
           note = ?, transcription = ?, updated_at = ?
           WHERE id = ?`,
          [sourceId, uri, start, duration, note, transcription, updated_at, id]
        )
      }
    } else {
      // Insert with specific ID
      this.db.runSync(
        `INSERT INTO clips (id, source_id, uri, start, duration, note, transcription, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, sourceId, uri, start, duration, note, transcription, created_at, updated_at]
      )
    }
  }

  /**
   * Get all clip IDs currently in the database.
   */
  getAllClipIds(): string[] {
    const results = this.db.getAllSync<{ id: string }>('SELECT id FROM clips')
    return results.map(r => r.id)
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  createSession(fileUri: string, start: number, duration: number): Session {
    const now = Date.now()
    const id = generateId()
    this.db.runSync(
      'INSERT INTO sessions (id, file_uri, start, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, fileUri, start, duration, now, now]
    )

    return {
      id,
      file_uri: fileUri,
      start,
      duration,
      created_at: now,
      updated_at: now,
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings(): Settings {
    const row = this.db.getFirstSync<{ sync_enabled: number }>(
      'SELECT sync_enabled FROM settings WHERE id = 1'
    )
    return {
      sync_enabled: row?.sync_enabled === 1,
    }
  }

  setSettings(settings: Settings): void {
    this.db.runSync(
      'UPDATE settings SET sync_enabled = ? WHERE id = 1',
      [settings.sync_enabled ? 1 : 0]
    )
  }

  // ---------------------------------------------------------------------------
  // Development
  // ---------------------------------------------------------------------------

  clearAllData(): void {
    this.db.runSync('DELETE FROM clips')
    this.db.runSync('DELETE FROM files')
    this.db.runSync('DELETE FROM sessions')
    this.db.runSync('DELETE FROM sync_manifest')
    this.db.runSync('DELETE FROM sync_queue')
    this.db.runSync('DELETE FROM sync_metadata')
    this.db.runSync('UPDATE settings SET sync_enabled = 0 WHERE id = 1')
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private initialize(): void {
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        uri TEXT,
        name TEXT NOT NULL,
        duration INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER,
        title TEXT,
        artist TEXT,
        artwork TEXT,
        file_size INTEGER,
        fingerprint BLOB
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_files_uri ON files(uri);`)
    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_files_file_size ON files(file_size);`)

    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS clips (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES files(id),
        uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        note TEXT NOT NULL,
        transcription TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_clips_source_id ON clips(source_id);`)

    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        file_uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_sessions_file_uri ON sessions(file_uri);`)

    // Sync tables
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS sync_manifest (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        local_updated_at INTEGER,
        remote_updated_at INTEGER,
        remote_file_id TEXT,
        remote_mp3_file_id TEXT,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      );
    `)

    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        UNIQUE(entity_type, entity_id)
      );
    `)

    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sync_enabled INTEGER NOT NULL DEFAULT 0
      );
    `)

    // Ensure settings row exists
    this.db.runSync(
      'INSERT OR IGNORE INTO settings (id, sync_enabled) VALUES (1, 0)'
    )
  }

  // ---------------------------------------------------------------------------
  // Sync Manifest
  // ---------------------------------------------------------------------------

  getManifestEntry(entityType: SyncEntityType, entityId: string): SyncManifestEntry | null {
    const result = this.db.getFirstSync<SyncManifestEntry>(
      'SELECT * FROM sync_manifest WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
    return result || null
  }

  getAllManifestEntries(entityType?: SyncEntityType): SyncManifestEntry[] {
    if (entityType) {
      return this.db.getAllSync<SyncManifestEntry>(
        'SELECT * FROM sync_manifest WHERE entity_type = ?',
        [entityType]
      )
    }
    return this.db.getAllSync<SyncManifestEntry>('SELECT * FROM sync_manifest')
  }

  upsertManifestEntry(entry: Omit<SyncManifestEntry, 'synced_at'>): void {
    const now = Date.now()
    this.db.runSync(
      `INSERT INTO sync_manifest (entity_type, entity_id, local_updated_at, remote_updated_at, remote_file_id, remote_mp3_file_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         local_updated_at = excluded.local_updated_at,
         remote_updated_at = excluded.remote_updated_at,
         remote_file_id = excluded.remote_file_id,
         remote_mp3_file_id = excluded.remote_mp3_file_id,
         synced_at = excluded.synced_at`,
      [entry.entity_type, entry.entity_id, entry.local_updated_at, entry.remote_updated_at, entry.remote_file_id, entry.remote_mp3_file_id ?? null, now]
    )
  }

  deleteManifestEntry(entityType: SyncEntityType, entityId: string): void {
    this.db.runSync(
      'DELETE FROM sync_manifest WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
  }

  // ---------------------------------------------------------------------------
  // Sync Queue
  // ---------------------------------------------------------------------------

  getQueueItem(entityType: SyncEntityType, entityId: string): SyncQueueItem | null {
    const result = this.db.getFirstSync<SyncQueueItem>(
      'SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
    return result || null
  }

  getAllQueueItems(): SyncQueueItem[] {
    return this.db.getAllSync<SyncQueueItem>(
      'SELECT * FROM sync_queue ORDER BY queued_at ASC'
    )
  }

  getPendingQueueItems(maxAttempts: number = 3): SyncQueueItem[] {
    return this.db.getAllSync<SyncQueueItem>(
      'SELECT * FROM sync_queue WHERE attempts < ? ORDER BY queued_at ASC',
      [maxAttempts]
    )
  }

  queueChange(entityType: SyncEntityType, entityId: string, operation: SyncOperation): void {
    const now = Date.now()
    const id = generateId()
    this.db.runSync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, queued_at, attempts, last_error)
       VALUES (?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         operation = excluded.operation,
         queued_at = excluded.queued_at,
         attempts = 0,
         last_error = NULL`,
      [id, entityType, entityId, operation, now]
    )
  }

  updateQueueItemAttempt(entityType: SyncEntityType, entityId: string, error: string | null): void {
    this.db.runSync(
      'UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE entity_type = ? AND entity_id = ?',
      [error, entityType, entityId]
    )
  }

  removeFromQueue(entityType: SyncEntityType, entityId: string): void {
    this.db.runSync(
      'DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
  }

  clearQueue(): void {
    this.db.runSync('DELETE FROM sync_queue')
  }

  getQueueCount(): number {
    const result = this.db.getFirstSync<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue')
    return result?.count ?? 0
  }

  // ---------------------------------------------------------------------------
  // Sync Metadata
  // ---------------------------------------------------------------------------

  getSyncMetadata(key: string): string | null {
    const result = this.db.getFirstSync<{ value: string }>(
      'SELECT value FROM sync_metadata WHERE key = ?',
      [key]
    )
    return result?.value ?? null
  }

  setSyncMetadata(key: string, value: string): void {
    this.db.runSync(
      `INSERT INTO sync_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    )
  }

  deleteSyncMetadata(key: string): void {
    this.db.runSync('DELETE FROM sync_metadata WHERE key = ?', [key])
  }

  getLastSyncTime(): number | null {
    const value = this.getSyncMetadata('lastSyncTime')
    return value ? parseInt(value, 10) : null
  }

  setLastSyncTime(timestamp: number): void {
    this.setSyncMetadata('lastSyncTime', timestamp.toString())
  }

  getDeviceId(): string | null {
    return this.getSyncMetadata('deviceId')
  }

  setDeviceId(deviceId: string): void {
    this.setSyncMetadata('deviceId', deviceId)
  }
}

