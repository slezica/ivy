/**
 * DatabaseService
 *
 * Wraps expo-sqlite to handle all database operations.
 * Manages clips, sessions, and files tables.
 */

import * as SQLite from 'expo-sqlite';

export interface Clip {
  id: number;
  file_uri: string;
  start: number;
  duration: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface FileRecord {
  uri: string;
  name: string;
  duration: number | null;
  position: number;
  opened_at: number | null;
}

export interface Session {
  id: number;
  file_uri: string;
  start: number;
  duration: number;
  created_at: number;
  updated_at: number;
}

export class DatabaseService {
  private db: SQLite.SQLiteDatabase;

  constructor() {
    this.db = SQLite.openDatabaseSync('audioplayer.db');
    this.initialize();
  }

  private initialize(): void {
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clips_file_uri ON clips(file_uri);

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_uri TEXT NOT NULL,
        start INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_file_uri ON sessions(file_uri);

      CREATE TABLE IF NOT EXISTS files (
        uri TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        duration INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        opened_at INTEGER
      );
    `);
  }

  // Clips operations
  getClipsForFile(fileUri: string): Clip[] {
    return this.db.getAllSync<Clip>(
      'SELECT * FROM clips WHERE file_uri = ? ORDER BY start ASC',
      [fileUri]
    );
  }

  createClip(fileUri: string, start: number, duration: number, note: string | null): Clip {
    const now = Date.now();
    const result = this.db.runSync(
      'INSERT INTO clips (file_uri, start, duration, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [fileUri, start, duration, note, now, now]
    );

    return {
      id: result.lastInsertRowId,
      file_uri: fileUri,
      start,
      duration,
      note,
      created_at: now,
      updated_at: now,
    };
  }

  updateClip(id: number, note: string | null): void {
    const now = Date.now();
    this.db.runSync(
      'UPDATE clips SET note = ?, updated_at = ? WHERE id = ?',
      [note, now, id]
    );
  }

  deleteClip(id: number): void {
    this.db.runSync('DELETE FROM clips WHERE id = ?', [id]);
  }

  // Files operations
  getFile(uri: string): FileRecord | null {
    const result = this.db.getFirstSync<FileRecord>(
      'SELECT * FROM files WHERE uri = ?',
      [uri]
    );
    return result || null;
  }

  upsertFile(uri: string, name: string, duration: number | null, position: number): void {
    const now = Date.now();
    const existing = this.getFile(uri);

    if (existing) {
      this.db.runSync(
        'UPDATE files SET name = ?, duration = ?, position = ?, opened_at = ? WHERE uri = ?',
        [name, duration, position, now, uri]
      );
    } else {
      this.db.runSync(
        'INSERT INTO files (uri, name, duration, position, opened_at) VALUES (?, ?, ?, ?, ?)',
        [uri, name, duration, position, now]
      );
    }
  }

  updateFilePosition(uri: string, position: number): void {
    this.db.runSync(
      'UPDATE files SET position = ? WHERE uri = ?',
      [position, uri]
    );
  }

  // Sessions operations (for future playback history)
  createSession(fileUri: string, start: number, duration: number): Session {
    const now = Date.now();
    const result = this.db.runSync(
      'INSERT INTO sessions (file_uri, start, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [fileUri, start, duration, now, now]
    );

    return {
      id: result.lastInsertRowId,
      file_uri: fileUri,
      start,
      duration,
      created_at: now,
      updated_at: now,
    };
  }
}
