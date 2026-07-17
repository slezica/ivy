/**
 * Migration upgrade-path tests (Layer 1).
 *
 * Jest's other tests run migrations only on FRESH databases. Real bugs hide in
 * the *upgrade* path: a migration correct on empty tables can corrupt or crash
 * on a device's older schema full of real data (the "fresh works, upgrade bites"
 * shape — the same class as the original ffmpeg-on-fresh-install bug, inverted).
 *
 * No external fixtures are needed: the `migrations` array is itself the schema
 * history, so we reconstruct any prior version by running a prefix of it, seed
 * realistic period-correct rows via raw SQL (the app's insert methods assume the
 * latest schema, so we can't use them to seed an old one), then run the pending
 * migration(s) and assert.
 *
 * The high-value targets are the DATA-TRANSFORMING migrations. Pure ADD COLUMN
 * migrations are safe by construction; the one that transforms data today is
 * migration 8 (clip source_title/source_artist backfill). Add a case here
 * whenever a future migration moves or rewrites existing rows.
 */

import { DatabaseService, migrations } from '../database'
import { createTestDatabase } from './sqlite_adapter'
import type * as SQLite from 'expo-sqlite'

// Build a raw DB at exactly migration `version` (runs migrations[0..version],
// leaving status.migration = version so a later `new DatabaseService(db)`
// resumes at version+1).
function dbAtVersion(version: number): SQLite.SQLiteDatabase {
  const db = createTestDatabase()
  for (let i = 0; i <= version; i++) {
    migrations[i](db)
    db.runSync('UPDATE status SET migration = ? WHERE id = 1', [i])
  }
  return db
}

function getAll<T>(db: SQLite.SQLiteDatabase, sql: string): T[] {
  return (db as unknown as { getAllSync: <U>(s: string) => U[] }).getAllSync<T>(sql)
}

describe('migration upgrade path', () => {
  describe('migration 8: clip source snapshot backfill', () => {
    // Seed a v7 database (before source_title existed) with the cases the
    // backfill must handle, then run migration 8 in isolation.
    function seededV7() {
      const db = dbAtVersion(7)
      // Books: titled, title-less (name fallback), and archived (hidden, no uri)
      db.runSync("INSERT INTO files (id, name, title, artist) VALUES ('book-titled', 'file.mp3', 'Real Title', 'Real Artist')")
      db.runSync("INSERT INTO files (id, name, title, artist) VALUES ('book-untitled', 'fallback.mp3', NULL, NULL)")
      db.runSync("INSERT INTO files (id, uri, name, title, artist, hidden) VALUES ('book-archived', NULL, 'arch.mp3', 'Arch Title', 'Arch Artist', 1)")
      // Clips (v7 shape: no source_title/source_artist columns yet)
      const clip = (id: string, src: string) =>
        db.runSync(`INSERT INTO clips (id, source_id, uri, start, duration, note, created_at, updated_at) VALUES ('${id}', '${src}', 'file:///c/${id}.m4a', 0, 1000, '', 1, 1)`)
      clip('clip-titled', 'book-titled')
      clip('clip-untitled', 'book-untitled')
      clip('clip-archived', 'book-archived')
      clip('clip-orphan', 'ghost') // book row genuinely gone (FKs off, mirrors device)
      return db
    }

    it('backfills title/artist from the book, leaving orphans null', () => {
      const db = seededV7()

      migrations[8](db)

      const rows = getAll<{ id: string; source_title: string | null; source_artist: string | null }>(
        db, 'SELECT id, source_title, source_artist FROM clips ORDER BY id'
      )
      const by = Object.fromEntries(rows.map(r => [r.id, r]))
      expect(by['clip-titled']).toEqual({ id: 'clip-titled', source_title: 'Real Title', source_artist: 'Real Artist' })
      expect(by['clip-untitled']).toEqual({ id: 'clip-untitled', source_title: 'fallback.mp3', source_artist: null }) // COALESCE(title, name)
      expect(by['clip-archived']).toEqual({ id: 'clip-archived', source_title: 'Arch Title', source_artist: 'Arch Artist' })
      expect(by['clip-orphan']).toEqual({ id: 'clip-orphan', source_title: null, source_artist: null }) // nothing to backfill from
    })
  })

  it('upgrades a populated v7 database to latest without loss or crash', async () => {
    const db = dbAtVersion(7)
    db.runSync("INSERT INTO files (id, uri, name, title, position) VALUES ('book-1', 'file:///a/book-1.mp3', 'Book.mp3', 'A Book', 5000)")
    db.runSync("INSERT INTO clips (id, source_id, uri, start, duration, note, created_at, updated_at) VALUES ('clip-1', 'book-1', 'file:///c/clip-1.m4a', 100, 2000, 'a note', 1, 1)")
    db.runSync("INSERT INTO sessions (id, book_id, started_at, ended_at) VALUES ('sess-1', 'book-1', 10, 20)")

    // Running the real service applies every pending migration to the old data.
    const service = new DatabaseService(db)

    const book = await service.getBookById('book-1')
    expect(book).not.toBeNull()
    expect(book!.position).toBe(5000)   // pre-existing data preserved
    expect(book!.speed).toBe(100)       // column added by a later migration, defaulted

    const [clip] = await service.getAllClips()
    expect(clip.id).toBe('clip-1')
    expect(clip.note).toBe('a note')
    expect(clip.source_title).toBe('A Book')  // backfilled during upgrade
  })
})
