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
  original_uri: string | null  // External content:// URI (reference only)
  name: string
  duration: number         // milliseconds
  position: number         // milliseconds (resume position)
  opened_at: number        // timestamp
  title: string | null
  artist: string | null
  artwork: string | null   // base64 data URI
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

  getAllBooks(): Book[] {
    return this.db.getAllSync<Book>(
      'SELECT * FROM files ORDER BY opened_at DESC'
    )
  }

  upsertBook(
    uri: string,
    name: string,
    duration: number | null,
    position: number,
    originalUri?: string | null,
    title?: string | null,
    artist?: string | null,
    artwork?: string | null
  ): Book {
    const now = Date.now()
    const existing = this.getBookByUri(uri)

    if (existing) {
      this.db.runSync(
        'UPDATE files SET name = ?, duration = ?, position = ?, opened_at = ?, original_uri = ?, title = ?, artist = ?, artwork = ? WHERE id = ?',
        [name, duration, position, now, originalUri ?? null, title ?? null, artist ?? null, artwork ?? null, existing.id]
      )
      return this.getBookById(existing.id)!
    } else {
      const result = this.db.runSync(
        'INSERT INTO files (uri, name, duration, position, opened_at, original_uri, title, artist, artwork) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uri, name, duration, position, now, originalUri ?? null, title ?? null, artist ?? null, artwork ?? null]
      )
      return this.getBookById(result.lastInsertRowId)!
    }
  }

  updateBookPosition(id: number, position: number): void {
    try {
      this.db.runSync(
        'UPDATE files SET position = ? WHERE id = ?',
        [position, id]
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
        original_uri TEXT,
        name TEXT NOT NULL,
        duration INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        opened_at INTEGER,
        title TEXT,
        artist TEXT,
        artwork TEXT
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_files_uri ON files(uri);`)

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
