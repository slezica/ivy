import * as SQLite from 'expo-sqlite'

export interface Clip {
  id: number
  file_uri: string
  start: number
  duration: number
  note: string
  created_at: number
  updated_at: number
}

export interface ClipWithFile extends Clip {
  file_name: string
  file_title: string | null
  file_artist: string | null
}

export interface AudioFile {
  uri: string
  original_uri: string | null
  name: string
  duration: number
  position: number
  opened_at: number
  title: string | null
  artist: string | null
  artwork: string | null
}

export interface Session {
  id: number
  file_uri: string
  start: number
  duration: number
  created_at: number
  updated_at: number
}

export class DatabaseService {
  private db: SQLite.SQLiteDatabase

  constructor() {
    this.db = SQLite.openDatabaseSync('audioplayer.db')
    this.initialize()
  }

  private initialize(): void {
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.db.execSync(`CREATE INDEX IF NOT EXISTS idx_clips_file_uri ON clips(file_uri);`)

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

    // Migration: Add original_uri column if it doesn't exist
    try {
      this.db.execSync(`ALTER TABLE files ADD COLUMN original_uri TEXT;`)
    } catch (error) {
      // Column already exists, ignore error
    }

    // Migration: Add metadata columns if they don't exist
    try {
      this.db.execSync(`ALTER TABLE files ADD COLUMN title TEXT;`)
    } catch (error) {
      // Column already exists, ignore error
    }

    try {
      this.db.execSync(`ALTER TABLE files ADD COLUMN artist TEXT;`)
    } catch (error) {
      // Column already exists, ignore error
    }

    try {
      this.db.execSync(`ALTER TABLE files ADD COLUMN artwork TEXT;`)
    } catch (error) {
      // Column already exists, ignore error
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Clips

  getClipsForFile(fileUri: string): Clip[] {
    return this.db.getAllSync<Clip>(
      'SELECT * FROM clips WHERE file_uri = ? ORDER BY start ASC',
      [fileUri]
    )
  }

  getAllClips(): ClipWithFile[] {
    return this.db.getAllSync<ClipWithFile>(
      `SELECT
        clips.*,
        files.name as file_name,
        files.title as file_title,
        files.artist as file_artist
      FROM clips
      INNER JOIN files ON clips.file_uri = files.uri
      ORDER BY clips.created_at DESC`
    )
  }

  createClip(fileUri: string, start: number, duration: number, note: string): Clip {
    const now = Date.now()
    const result = this.db.runSync(
      'INSERT INTO clips (file_uri, start, duration, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [fileUri, start, duration, note, now, now]
    )

    return {
      id: result.lastInsertRowId,
      file_uri: fileUri,
      start,
      duration,
      note,
      created_at: now,
      updated_at: now,
    }
  }

  updateClip(id: number, note: string): void {
    const now = Date.now()
    this.db.runSync(
      'UPDATE clips SET note = ?, updated_at = ? WHERE id = ?',
      [note, now, id]
    )
  }

  deleteClip(id: number): void {
    this.db.runSync('DELETE FROM clips WHERE id = ?', [id])
  }

  // -----------------------------------------------------------------------------------------------
  // Files

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
      // Silently ignore database errors during position updates
      // This can happen during app transitions/resets when DB is being closed
      // Position will be updated on next successful write
      console.debug('Failed to update file position (non-critical):', error)
    }
  }

  // Development: Clear all data
  clearAllData(): void {
    this.db.runSync('DELETE FROM clips')
    this.db.runSync('DELETE FROM files')
    this.db.runSync('DELETE FROM sessions')
  }

  // -----------------------------------------------------------------------------------------------
  // Sessions

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
}
