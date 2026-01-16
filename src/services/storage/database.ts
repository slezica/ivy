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

export interface AudioFile {
  uri: string              // Local file:// path (used for playback)
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
  source_uri: string       // References files.uri (parent file)
  uri: string              // Clip's own audio file
  start: number            // milliseconds
  duration: number         // milliseconds
  note: string
  transcription: string | null  // Auto-generated from audio
  created_at: number
  updated_at: number
}

export interface ClipWithFile extends Clip {
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
  // Files
  // ---------------------------------------------------------------------------

  getFile(uri: string): AudioFile | null {
    const result = this.db.getFirstSync<AudioFile>(
      'SELECT * FROM files WHERE uri = ?',
      [uri]
    )
    return result || null
  }

  getAllFiles(): AudioFile[] {
    return this.db.getAllSync<AudioFile>(
      'SELECT * FROM files ORDER BY opened_at DESC'
    )
  }

  upsertFile(
    uri: string,
    name: string,
    duration: number | null,
    position: number,
    originalUri?: string | null,
    title?: string | null,
    artist?: string | null,
    artwork?: string | null
  ): void {
    const now = Date.now()
    const existing = this.getFile(uri)

    if (existing) {
      this.db.runSync(
        'UPDATE files SET name = ?, duration = ?, position = ?, opened_at = ?, original_uri = ?, title = ?, artist = ?, artwork = ? WHERE uri = ?',
        [name, duration, position, now, originalUri ?? null, title ?? null, artist ?? null, artwork ?? null, uri]
      )
    } else {
      this.db.runSync(
        'INSERT INTO files (uri, name, duration, position, opened_at, original_uri, title, artist, artwork) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uri, name, duration, position, now, originalUri ?? null, title ?? null, artist ?? null, artwork ?? null]
      )
    }
  }

  updateFilePosition(uri: string, position: number): void {
    try {
      this.db.runSync(
        'UPDATE files SET position = ? WHERE uri = ?',
        [position, uri]
      )
    } catch (error) {
      // Silently ignore during app transitions/resets
      console.debug('Failed to update file position (non-critical):', error)
    }
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

  getClipsForFile(fileUri: string): Clip[] {
    return this.db.getAllSync<Clip>(
      'SELECT * FROM clips WHERE source_uri = ? ORDER BY start ASC',
      [fileUri]
    )
  }

  getAllClips(): ClipWithFile[] {
    return this.db.getAllSync<ClipWithFile>(
      `SELECT
        clips.*,
        files.name as file_name,
        files.title as file_title,
        files.artist as file_artist,
        files.duration as file_duration
      FROM clips
      INNER JOIN files ON clips.source_uri = files.uri
      ORDER BY clips.created_at DESC`
    )
  }

  createClip(sourceUri: string, uri: string, start: number, duration: number, note: string): Clip {
    const now = Date.now()
    const result = this.db.runSync(
      'INSERT INTO clips (source_uri, uri, start, duration, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sourceUri, uri, start, duration, note, now, now]
    )

    return {
      id: result.lastInsertRowId,
      source_uri: sourceUri,
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
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_uri TEXT NOT NULL,
        uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_clips_source_uri ON clips(source_uri);`)

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

    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS files (
        uri TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        duration INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        opened_at INTEGER
      );
    `)

    // Migrations
    this.migrate('ALTER TABLE files ADD COLUMN original_uri TEXT')
    this.migrate('ALTER TABLE files ADD COLUMN title TEXT')
    this.migrate('ALTER TABLE files ADD COLUMN artist TEXT')
    this.migrate('ALTER TABLE files ADD COLUMN artwork TEXT')
    this.migrate('ALTER TABLE clips ADD COLUMN transcription TEXT')
  }

  private migrate(sql: string): void {
    try {
      this.db.execSync(sql)
    } catch {
      // Column already exists
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const databaseService = new DatabaseService()
