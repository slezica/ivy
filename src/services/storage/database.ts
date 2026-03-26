/**
 * Database Service
 *
 * SQLite operations for files, clips, and sessions.
 * Single source of truth for persistent app data.
 */

import * as SQLite from 'expo-sqlite'

import { generateId, createLogger } from '../../utils'

const log = createLogger('Database')

// =============================================================================
// Public Interface
// =============================================================================

export interface Status {
  migration: number
}

export interface Chapter {
  title: string | null
  start_ms: number
  end_ms: number
}

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
  hidden: boolean          // Soft-deleted (removed from library)
  chapters: Chapter[] | null  // From file metadata (not synced)
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
  book_id: string
  started_at: number
  ended_at: number
}

export interface SessionWithBook extends Session {
  book_name: string
  book_title: string | null
  book_artist: string | null
  book_artwork: string | null
}

export interface Settings {
  sync_enabled: boolean
  transcription_enabled: boolean
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
  remote_audio_file_id: string | null // Drive file ID (MP3, clips only)
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
// Migrations
// =============================================================================

type Migration = (db: SQLite.SQLiteDatabase) => void

const migrations: Migration[] = [
  // Migration 0: Initial schema
  (db) => {
    // Status table (for tracking migrations)
    db.execSync(`
      CREATE TABLE IF NOT EXISTS status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        migration INTEGER NOT NULL
      );
    `)

    db.execSync(`
      INSERT INTO status (id, migration) VALUES (1, 0);
    `)

    // Files table (books)
    db.execSync(`
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
        fingerprint BLOB,
        hidden INTEGER NOT NULL DEFAULT 0
      );
    `)
    db.execSync(`CREATE INDEX IF NOT EXISTS idx_files_uri ON files(uri);`)
    db.execSync(`CREATE INDEX IF NOT EXISTS idx_files_file_size ON files(file_size);`)

    // Clips table
    db.execSync(`
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
    db.execSync(`CREATE INDEX IF NOT EXISTS idx_clips_source_id ON clips(source_id);`)

    // Sessions table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES files(id),
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      );
    `)
    db.execSync(`CREATE INDEX IF NOT EXISTS idx_sessions_book_id ON sessions(book_id);`)

    // Sync tables
    db.execSync(`
      CREATE TABLE IF NOT EXISTS sync_manifest (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        local_updated_at INTEGER,
        remote_updated_at INTEGER,
        remote_file_id TEXT,
        remote_audio_file_id TEXT,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      );
    `)

    db.execSync(`
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

    db.execSync(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // Settings table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sync_enabled INTEGER NOT NULL DEFAULT 0,
        transcription_enabled INTEGER NOT NULL DEFAULT 1
      );
    `)
    db.runSync('INSERT OR IGNORE INTO settings (id, sync_enabled) VALUES (1, 0)')
  },

  // Migration 1: Add chapters column to files table
  (db) => {
    db.execSync('ALTER TABLE files ADD COLUMN chapters TEXT')
  },
]

// =============================================================================
// Service
// =============================================================================

// Raw book row from database (hidden is integer, chapters is JSON string)
type BookRow = Omit<Book, 'hidden' | 'chapters'> & { hidden: number; chapters: string | null }

function toBook(row: BookRow): Book {
  let chapters: Chapter[] | null = null
  if (row.chapters) {
    try { chapters = JSON.parse(row.chapters) } catch {}
  }
  return { ...row, hidden: row.hidden === 1, chapters }
}

export class DatabaseService {
  private db: SQLite.SQLiteDatabase

  constructor() {
    this.db = SQLite.openDatabaseSync('audioplayer.db')
    this.runMigrations() // TODO this shouldn't be in the constructor
  }

  // ---------------------------------------------------------------------------
  // Books
  // ---------------------------------------------------------------------------

  async getBookByUri(uri: string): Promise<Book | null> {
    const row = await this.db.getFirstAsync<BookRow>(
      'SELECT * FROM files WHERE uri = ?',
      [uri]
    )
    return row ? toBook(row) : null
  }

  async getBookById(id: string): Promise<Book | null> {
    const row = await this.db.getFirstAsync<BookRow>(
      'SELECT * FROM files WHERE id = ?',
      [id]
    )
    return row ? toBook(row) : null
  }

  async getBookByFingerprint(fileSize: number, fingerprint: Uint8Array): Promise<Book | null> {
    const row = await this.db.getFirstAsync<BookRow>(
      'SELECT * FROM files WHERE file_size = ? AND fingerprint = ?',
      [fileSize, fingerprint]
    )
    return row ? toBook(row) : null
  }

  /**
   * Find a Book by URI - either the book's own URI or one of its clip URIs.
   * Useful for playback where the URI could be a book or a clip's audio file.
   */
  async getBookByAnyUri(uri: string): Promise<Book | null> {
    // First try direct book lookup
    const book = await this.getBookByUri(uri)
    if (book) return book

    // Try to find a clip with this URI and return its source book
    const row = await this.db.getFirstAsync<BookRow>(
      `SELECT files.* FROM files
       INNER JOIN clips ON clips.source_id = files.id
       WHERE clips.uri = ?`,
      [uri]
    )
    return row ? toBook(row) : null
  }

  getLastPlayedBook(): Book | null {
    const row = this.db.getFirstSync<BookRow>(
      'SELECT * FROM files WHERE hidden = 0 AND uri IS NOT NULL ORDER BY updated_at DESC LIMIT 1'
    )
    return row ? toBook(row) : null
  }

  async getAllBooks(): Promise<Book[]> {
    const rows = await this.db.getAllAsync<BookRow>(
      'SELECT * FROM files WHERE hidden = 0 ORDER BY updated_at DESC'
    )
    return rows.map(toBook)
  }

  async upsertBook(
    id: string,
    uri: string,
    name: string,
    duration: number | null,
    position: number,
    title?: string | null,
    artist?: string | null,
    artwork?: string | null,
    fileSize?: number,
    fingerprint?: Uint8Array,
    chapters?: Chapter[] | null,
  ): Promise<void> {
    const now = Date.now()
    const chaptersJson = chapters?.length ? JSON.stringify(chapters) : null
    await this.db.runAsync(
      `INSERT INTO files (id, uri, name, duration, position, updated_at, title, artist, artwork, file_size, fingerprint, chapters)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         uri = excluded.uri, name = excluded.name, duration = excluded.duration,
         position = excluded.position, updated_at = excluded.updated_at,
         title = excluded.title, artist = excluded.artist, artwork = excluded.artwork,
         file_size = excluded.file_size, fingerprint = excluded.fingerprint,
         chapters = excluded.chapters`,
      [id, uri, name, duration, position, now, title ?? null, artist ?? null, artwork ?? null, fileSize ?? null, fingerprint ?? null, chaptersJson]
    )
  }

  /**
   * Restore an archived/hidden book by attaching a new file.
   * Preserves position, updates uri and metadata, clears hidden flag, refreshes updated_at.
   */
  async restoreBook(
    id: string,
    uri: string,
    name: string,
    duration: number,
    title: string | null,
    artist: string | null,
    artwork: string | null,
    fileSize: number,
    fingerprint: Uint8Array,
    chapters?: Chapter[] | null,
  ): Promise<void> {
    const now = Date.now()
    const chaptersJson = chapters?.length ? JSON.stringify(chapters) : null
    await this.db.runAsync(
      'UPDATE files SET uri = ?, name = ?, duration = ?, updated_at = ?, title = ?, artist = ?, artwork = ?, file_size = ?, fingerprint = ?, hidden = 0, chapters = ? WHERE id = ?',
      [uri, name, duration, now, title, artist, artwork, fileSize, fingerprint, chaptersJson, id]
    )
  }

  /**
   * Soft-delete a book (remove from library).
   * Sets uri to null and hidden to true. File deletion is caller's responsibility.
   */
  async hideBook(id: string): Promise<void> {
    await this.db.runAsync(
      'UPDATE files SET uri = NULL, hidden = 1 WHERE id = ?',
      [id]
    )
  }

  /**
   * Touch an existing book to update updated_at timestamp.
   */
  async touchBook(id: string): Promise<void> {
    const now = Date.now()
    await this.db.runAsync(
      'UPDATE files SET updated_at = ? WHERE id = ?',
      [now, id]
    )
  }

  async updateBookMetadata(id: string, title: string | null, artist: string | null): Promise<void> {
    const now = Date.now()
    await this.db.runAsync(
      'UPDATE files SET title = ?, artist = ?, updated_at = ? WHERE id = ?',
      [title, artist, now, id]
    )
  }

  updateBookPosition(id: string, position: number): void {
    const now = Date.now()
    this.db.runAsync(
      'UPDATE files SET position = ?, updated_at = ? WHERE id = ?',
      [position, now, id]
    ).catch((error) => {
      // Silently ignore during app transitions/resets
      console.debug('Failed to update book position (non-critical):', error)
    })
  }

  async archiveBook(id: string): Promise<void> {
    await this.db.runAsync(
      'UPDATE files SET uri = NULL WHERE id = ?',
      [id]
    )
  }

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------

  async getClip(id: string): Promise<Clip | null> {
    const result = await this.db.getFirstAsync<Clip>(
      'SELECT * FROM clips WHERE id = ?',
      [id]
    )
    return result || null
  }

  async getClipsForBook(bookId: string): Promise<Clip[]> {
    return this.db.getAllAsync<Clip>(
      'SELECT * FROM clips WHERE source_id = ? ORDER BY start ASC',
      [bookId]
    )
  }

  async getAllClips(): Promise<ClipWithFile[]> {
    return this.db.getAllAsync<ClipWithFile>(
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

  async createClip(id: string, sourceId: string, uri: string, start: number, duration: number, note: string): Promise<Clip> {
    const now = Date.now()
    await this.db.runAsync(
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

  async updateClip(id: string, updates: { note?: string; start?: number; duration?: number; uri?: string; transcription?: string | null }): Promise<void> {
    const now = Date.now()
    const setClauses: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [now]

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
    await this.db.runAsync(
      `UPDATE clips SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    )
  }

  async getClipsNeedingTranscription(): Promise<Clip[]> {
    return this.db.getAllAsync<Clip>(
      'SELECT * FROM clips WHERE transcription IS NULL ORDER BY created_at ASC'
    )
  }

  async deleteClip(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM clips WHERE id = ?', [id])
  }

  // ---------------------------------------------------------------------------
  // Backup / Restore
  // ---------------------------------------------------------------------------

  /**
   * Restore a book from backup. Inserts if new, updates if exists and newer.
   * Does not set uri (file path) - caller must handle file restoration separately.
   */
  async restoreBookFromBackup(
    id: string,
    name: string,
    duration: number,
    position: number,
    updated_at: number,
    title: string | null,
    artist: string | null,
    artwork: string | null,
    fileSize: number,
    fingerprint: Uint8Array,
    hidden: boolean = false
  ): Promise<void> {
    // Insert or update-if-newer in a single statement.
    // The WHERE on the UPDATE branch ensures we only overwrite with newer data.
    await this.db.runAsync(
      `INSERT INTO files (id, uri, name, duration, position, updated_at, title, artist, artwork, file_size, fingerprint, hidden)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, duration = excluded.duration,
         position = excluded.position, updated_at = excluded.updated_at,
         title = excluded.title, artist = excluded.artist, artwork = excluded.artwork,
         file_size = excluded.file_size, fingerprint = excluded.fingerprint, hidden = excluded.hidden
       WHERE excluded.updated_at > files.updated_at`,
      [id, name, duration, position, updated_at, title, artist, artwork, fileSize, fingerprint, hidden ? 1 : 0]
    )
  }

  /**
   * Restore a clip from backup. Inserts if new, updates if exists and newer.
   */
  async restoreClipFromBackup(
    id: string,
    sourceId: string,
    uri: string,
    start: number,
    duration: number,
    note: string,
    transcription: string | null,
    created_at: number,
    updated_at: number
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO clips (id, source_id, uri, start, duration, note, transcription, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_id = excluded.source_id, uri = excluded.uri,
         start = excluded.start, duration = excluded.duration,
         note = excluded.note, transcription = excluded.transcription,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > clips.updated_at`,
      [id, sourceId, uri, start, duration, note, transcription, created_at, updated_at]
    )
  }

  /**
   * Get all clip IDs currently in the database.
   */
  async getAllClipIds(): Promise<string[]> {
    const results = await this.db.getAllAsync<{ id: string }>('SELECT id FROM clips')
    return results.map(r => r.id)
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Get the current active session for a book (most recent, ended within 5 minutes).
   */
  async getCurrentSession(bookId: string): Promise<Session | null> {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
    const row = await this.db.getFirstAsync<Session>(
      `SELECT * FROM sessions
       WHERE book_id = ? AND ended_at > ?
       ORDER BY started_at DESC
       LIMIT 1`,
      [bookId, fiveMinutesAgo]
    )
    return row ?? null
  }

  async createSession(bookId: string): Promise<Session> {
    const now = Date.now()
    const id = generateId()
    await this.db.runAsync(
      'INSERT INTO sessions (id, book_id, started_at, ended_at) VALUES (?, ?, ?, ?)',
      [id, bookId, now, now]
    )
    return { id, book_id: bookId, started_at: now, ended_at: now }
  }

  updateSessionEndedAt(sessionId: string, endedAt: number): void {
    this.db.runAsync(
      'UPDATE sessions SET ended_at = ? WHERE id = ?',
      [endedAt, sessionId]
    ).catch((error) => {
      console.debug('Failed to update session ended_at (non-critical):', error)
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM sessions WHERE id = ?', [sessionId])
  }

  async getAllSessions(): Promise<SessionWithBook[]> {
    return this.db.getAllAsync<SessionWithBook>(
      `SELECT
        sessions.*,
        files.name as book_name,
        files.title as book_title,
        files.artist as book_artist,
        files.artwork as book_artwork
      FROM sessions
      INNER JOIN files ON sessions.book_id = files.id
      ORDER BY sessions.started_at DESC`
    )
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings(): Settings {
    const row = this.db.getFirstSync<{ sync_enabled: number; transcription_enabled: number }>(
      'SELECT sync_enabled, transcription_enabled FROM settings WHERE id = 1'
    )
    return {
      sync_enabled: row?.sync_enabled === 1,
      transcription_enabled: row?.transcription_enabled !== 0, // default true
    }
  }

  async setSettings(settings: Settings): Promise<void> {
    await this.db.runAsync(
      'UPDATE settings SET sync_enabled = ?, transcription_enabled = ? WHERE id = 1',
      [settings.sync_enabled ? 1 : 0, settings.transcription_enabled ? 1 : 0]
    )
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Returns all file URIs referenced by books and clips. */
  async getAllFileUris(): Promise<Set<string>> {
    const uris = new Set<string>()

    const bookRows = await this.db.getAllAsync<{ uri: string | null }>('SELECT uri FROM files')
    for (const row of bookRows) {
      if (row.uri) uris.add(row.uri)
    }

    const clipRows = await this.db.getAllAsync<{ uri: string }>('SELECT uri FROM clips')
    for (const row of clipRows) {
      uris.add(row.uri)
    }

    return uris
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

  private runMigrations(): void {
    log('Running migrations')

    // Decide what the next migration to apply is (if any):
    let nextMigration
    try {
      const row = this.db.getFirstSync<Status>('SELECT migration FROM status WHERE id = 1')

      // Table exists (we know row too), start after the last recorded migration:
      nextMigration = row!.migration + 1 

    } catch {
      // Table does not exist, start from special migration 0:
      nextMigration = 0
    }

    // Run pending migrations:
    for (let i = nextMigration; i < migrations.length; i++) {
      log(`Running migration ${i}`)

      // Apply! If this throws, we should just fail, nothing else makes sense:
      migrations[i](this.db) 
      this.db.runSync('UPDATE status SET migration = ? WHERE id = 1', [i])
    }
  }

  // ---------------------------------------------------------------------------
  // Sync Manifest
  // ---------------------------------------------------------------------------

  async getManifestEntry(entityType: SyncEntityType, entityId: string): Promise<SyncManifestEntry | null> {
    const result = await this.db.getFirstAsync<SyncManifestEntry>(
      'SELECT * FROM sync_manifest WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
    return result || null
  }

  async getAllManifestEntries(entityType?: SyncEntityType): Promise<SyncManifestEntry[]> {
    if (entityType) {
      return this.db.getAllAsync<SyncManifestEntry>(
        'SELECT * FROM sync_manifest WHERE entity_type = ?',
        [entityType]
      )
    }
    return this.db.getAllAsync<SyncManifestEntry>('SELECT * FROM sync_manifest')
  }

  async upsertManifestEntry(entry: Omit<SyncManifestEntry, 'synced_at'>): Promise<void> {
    const now = Date.now()
    await this.db.runAsync(
      `INSERT INTO sync_manifest (entity_type, entity_id, local_updated_at, remote_updated_at, remote_file_id, remote_audio_file_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         local_updated_at = excluded.local_updated_at,
         remote_updated_at = excluded.remote_updated_at,
         remote_file_id = excluded.remote_file_id,
         remote_audio_file_id = excluded.remote_audio_file_id,
         synced_at = excluded.synced_at`,
      [entry.entity_type, entry.entity_id, entry.local_updated_at, entry.remote_updated_at, entry.remote_file_id, entry.remote_audio_file_id ?? null, now]
    )
  }

  async deleteManifestEntry(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM sync_manifest WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
  }

  // ---------------------------------------------------------------------------
  // Sync Queue
  // ---------------------------------------------------------------------------

  async getQueueItem(entityType: SyncEntityType, entityId: string): Promise<SyncQueueItem | null> {
    const result = await this.db.getFirstAsync<SyncQueueItem>(
      'SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
    return result || null
  }

  async getAllQueueItems(): Promise<SyncQueueItem[]> {
    return this.db.getAllAsync<SyncQueueItem>(
      'SELECT * FROM sync_queue ORDER BY queued_at ASC'
    )
  }

  async getPendingQueueItems(maxAttempts: number = 3): Promise<SyncQueueItem[]> {
    return this.db.getAllAsync<SyncQueueItem>(
      'SELECT * FROM sync_queue WHERE attempts < ? ORDER BY queued_at ASC',
      [maxAttempts]
    )
  }

  async queueChange(entityType: SyncEntityType, entityId: string, operation: SyncOperation): Promise<void> {
    const now = Date.now()
    const id = generateId()
    await this.db.runAsync(
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

  async updateQueueItemAttempt(entityType: SyncEntityType, entityId: string, error: string | null): Promise<void> {
    await this.db.runAsync(
      'UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE entity_type = ? AND entity_id = ?',
      [error, entityType, entityId]
    )
  }

  async removeFromQueue(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    )
  }

  async clearQueue(): Promise<void> {
    await this.db.runAsync('DELETE FROM sync_queue')
  }

  async getQueueCount(maxAttempts: number = 3): Promise<number> {
    const result = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM sync_queue WHERE attempts < ?',
      [maxAttempts]
    )
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

  async setSyncMetadata(key: string, value: string): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    )
  }

  async deleteSyncMetadata(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM sync_metadata WHERE key = ?', [key])
  }

  getLastSyncTime(): number | null {
    const value = this.getSyncMetadata('lastSyncTime')
    return value ? parseInt(value, 10) : null
  }

  async setLastSyncTime(timestamp: number): Promise<void> {
    await this.setSyncMetadata('lastSyncTime', timestamp.toString())
  }

  getDeviceId(): string | null {
    return this.getSyncMetadata('deviceId')
  }

  async setDeviceId(deviceId: string): Promise<void> {
    await this.setSyncMetadata('deviceId', deviceId)
  }
}

