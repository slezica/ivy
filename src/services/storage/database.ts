/**
 * Database Service
 *
 * SQLite operations for files, clips, and sessions.
 * Single source of truth for persistent app data.
 */

import * as SQLite from 'expo-sqlite'

// =============================================================================
// Public Interface
// =============================================================================

export interface Book {
  id: number               // Auto-increment primary key
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
  id: number
  source_id: number        // References files.id (parent file)
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
  id: number
  file_uri: string
  start: number
  duration: number
  created_at: number
  updated_at: number
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

  getBookById(id: number): Book | null {
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
    const existing = this.getBookByUri(uri)

    if (existing) {
      this.db.runSync(
        'UPDATE files SET name = ?, duration = ?, position = ?, updated_at = ?, title = ?, artist = ?, artwork = ?, file_size = ?, fingerprint = ? WHERE id = ?',
        [name, duration, position, now, title ?? null, artist ?? null, artwork ?? null, fileSize ?? null, fingerprint ?? null, existing.id]
      )
      return this.getBookById(existing.id)!
    } else {
      const result = this.db.runSync(
        'INSERT INTO files (uri, name, duration, position, updated_at, title, artist, artwork, file_size, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uri, name, duration, position, now, title ?? null, artist ?? null, artwork ?? null, fileSize ?? null, fingerprint ?? null]
      )
      return this.getBookById(result.lastInsertRowId)!
    }
  }

  /**
   * Restore an archived book by attaching a new file.
   * Preserves position, updates uri and metadata, refreshes updated_at.
   */
  restoreBook(
    id: number,
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
  touchBook(id: number): void {
    const now = Date.now()
    this.db.runSync(
      'UPDATE files SET updated_at = ? WHERE id = ?',
      [now, id]
    )
  }

  updateBookPosition(id: number, position: number): void {
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

  archiveBook(id: number): void {
    this.db.runSync(
      'UPDATE files SET uri = NULL WHERE id = ?',
      [id]
    )
  }

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------

  getClip(id: number): Clip | null {
    const result = this.db.getFirstSync<Clip>(
      'SELECT * FROM clips WHERE id = ?',
      [id]
    )
    return result || null
  }

  getClipsForBook(bookId: number): Clip[] {
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

  createClip(sourceId: number, uri: string, start: number, duration: number, note: string): Clip {
    const now = Date.now()
    const result = this.db.runSync(
      'INSERT INTO clips (source_id, uri, start, duration, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sourceId, uri, start, duration, note, now, now]
    )

    return {
      id: result.lastInsertRowId,
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

  updateClip(id: number, updates: { note?: string; start?: number; duration?: number; uri?: string }): void {
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

    values.push(id)
    this.db.runSync(
      `UPDATE clips SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    )
  }

  updateClipTranscription(id: number, transcription: string): void {
    const now = Date.now()
    this.db.runSync(
      'UPDATE clips SET transcription = ?, updated_at = ? WHERE id = ?',
      [transcription, now, id]
    )
  }

  getClipsNeedingTranscription(): Clip[] {
    return this.db.getAllSync<Clip>(
      'SELECT * FROM clips WHERE transcription IS NULL ORDER BY created_at ASC'
    )
  }

  deleteClip(id: number): void {
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
    id: number,
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
    id: number,
    sourceId: number,
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
  getAllClipIds(): number[] {
    const results = this.db.getAllSync<{ id: number }>('SELECT id FROM clips')
    return results.map(r => r.id)
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  createSession(fileUri: string, start: number, duration: number): Session {
    const now = Date.now()
    const result = this.db.runSync(
      'INSERT INTO sessions (file_uri, start, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [fileUri, start, duration, now, now]
    )

    return {
      id: result.lastInsertRowId,
      file_uri: fileUri,
      start,
      duration,
      created_at: now,
      updated_at: now,
    }
  }

  // ---------------------------------------------------------------------------
  // Development
  // ---------------------------------------------------------------------------

  clearAllData(): void {
    this.db.runSync('DELETE FROM clips')
    this.db.runSync('DELETE FROM files')
    this.db.runSync('DELETE FROM sessions')
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private initialize(): void {
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES files(id),
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_sessions_file_uri ON sessions(file_uri);`)
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const databaseService = new DatabaseService()
