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
 * migrations are safe by construction; the data-transforming ones today are
 * migration 8 (clip source snapshot backfill), 12 (transcription quote strip),
 * and 13 (artwork downscale repair). Add a case here whenever a future
 * migration moves or rewrites existing rows.
 */

import { DatabaseService, migrations } from '../database'
import { createTestDatabase, testMigrationDeps } from './sqlite_adapter'
import type * as SQLite from 'expo-sqlite'

// Build a raw DB at exactly migration `version` (runs migrations[0..version],
// leaving status.migration = version so a later `service.migrate()` resumes
// at version+1).
async function dbAtVersion(version: number): Promise<SQLite.SQLiteDatabase> {
  const db = createTestDatabase()
  for (let i = 0; i <= version; i++) {
    await migrations[i](db, testMigrationDeps)
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
    async function seededV7() {
      const db = await dbAtVersion(7)
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

    it('backfills title/artist from the book, leaving orphans null', async () => {
      const db = await seededV7()

      await migrations[8](db, testMigrationDeps)

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

  describe('migration 12: strip enclosing quotes from transcriptions', () => {
    async function seededV11() {
      const db = await dbAtVersion(11)
      const clip = (id: string, transcription: string | null) =>
        db.runSync(
          "INSERT INTO clips (id, source_id, uri, start, duration, note, transcription, created_at, updated_at) VALUES (?, 'book-1', ?, 0, 1000, '', ?, 1, 42)",
          [id, `file:///c/${id}.m4a`, transcription]
        )
      clip('clip-quoted', '"Fully quoted text."')
      clip('clip-curly', '“Curly quoted text.”')
      clip('clip-suffixed', '"Long clip text."...')
      clip('clip-dialogue', '"Hello", he said. "How are you?"')
      clip('clip-plain', 'No quotes at all.')
      clip('clip-null', null)
      return db
    }

    it('strips only enclosing quotes, preserving the long-clip suffix', async () => {
      const db = await seededV11()

      await migrations[12](db, testMigrationDeps)

      const rows = getAll<{ id: string; transcription: string | null; updated_at: number }>(
        db, 'SELECT id, transcription, updated_at FROM clips ORDER BY id'
      )
      const by = Object.fromEntries(rows.map(r => [r.id, r]))
      expect(by['clip-quoted'].transcription).toBe('Fully quoted text.')
      expect(by['clip-curly'].transcription).toBe('Curly quoted text.')
      expect(by['clip-suffixed'].transcription).toBe('Long clip text....')
      expect(by['clip-dialogue'].transcription).toBe('"Hello", he said. "How are you?"')
      expect(by['clip-plain'].transcription).toBe('No quotes at all.')
      expect(by['clip-null'].transcription).toBeNull()
      // Per-device normalization: never bumps updated_at (would churn sync LWW)
      expect(rows.every(r => r.updated_at === 42)).toBe(true)
    })
  })

  describe('migration 13: downscale oversized artwork', () => {
    const FAT = 'data:image/jpeg;base64,' + 'x'.repeat(200_000)
    const SMALL = 'data:image/jpeg;base64,' + 'y'.repeat(5_000)

    async function seededV12() {
      const db = await dbAtVersion(12)
      const book = (id: string, artwork: string | null) =>
        db.runSync(
          "INSERT INTO files (id, uri, name, artwork, updated_at, updated_by) VALUES (?, ?, ?, ?, 42, 'other-device')",
          [id, `file:///a/${id}.mp3`, `${id}.mp3`, artwork]
        )
      book('book-fat', FAT)
      book('book-fat-2', FAT)
      book('book-small', SMALL)
      book('book-none', null)
      return db
    }

    function artworkRows(db: SQLite.SQLiteDatabase) {
      const rows = getAll<{ id: string; artwork: string | null; updated_at: number; updated_by: string | null }>(
        db, 'SELECT id, artwork, updated_at, updated_by FROM files ORDER BY id'
      )
      return Object.fromEntries(rows.map(r => [r.id, r]))
    }

    it('downscales only oversized artwork, bumps updated_at, and queues for sync', async () => {
      const db = await seededV12()
      const downscaled = 'data:image/jpeg;base64,DOWNSCALED'

      await migrations[13](db, { metadata: { downscaleArtwork: async () => downscaled } })

      const by = artworkRows(db)
      expect(by['book-fat'].artwork).toBe(downscaled)
      expect(by['book-fat'].updated_at).toBeGreaterThan(42)     // LWW bump: repair propagates
      expect(by['book-fat'].updated_by).not.toBe('other-device') // claimed by this device
      expect(by['book-fat-2'].artwork).toBe(downscaled)
      expect(by['book-small']).toMatchObject({ artwork: SMALL, updated_at: 42, updated_by: 'other-device' })
      expect(by['book-none']).toMatchObject({ artwork: null, updated_at: 42 })

      const queued = getAll<{ entity_type: string; entity_id: string; operation: string }>(
        db, 'SELECT entity_type, entity_id, operation FROM sync_queue ORDER BY entity_id'
      )
      expect(queued).toEqual([
        { entity_type: 'book', entity_id: 'book-fat', operation: 'upsert' },
        { entity_type: 'book', entity_id: 'book-fat-2', operation: 'upsert' },
      ])
    })

    it('skips books whose downscale fails or does not shrink, repairing the rest', async () => {
      const db = await seededV12()
      const downscaled = 'data:image/jpeg;base64,DOWNSCALED'
      let first = true

      await migrations[13](db, { metadata: { downscaleArtwork: async () => {
        if (first) { first = false; throw new Error('decode failed') } // book-fat
        return downscaled // book-fat-2
      } } })

      const by = artworkRows(db)
      expect(by['book-fat']).toMatchObject({ artwork: FAT, updated_at: 42 }) // untouched, not queued
      expect(by['book-fat-2'].artwork).toBe(downscaled)                      // still repaired

      const queued = getAll<{ entity_id: string }>(db, 'SELECT entity_id FROM sync_queue')
      expect(queued).toEqual([{ entity_id: 'book-fat-2' }])
    })

    it('drops undecodable artwork (null from the downscaler) and queues the drop', async () => {
      const db = await seededV12()

      await migrations[13](db, { metadata: { downscaleArtwork: async () => null } })

      const by = artworkRows(db)
      expect(by['book-fat'].artwork).toBeNull()          // unrenderable heap bomb: dropped
      expect(by['book-fat'].updated_at).toBeGreaterThan(42)
      expect(by['book-fat-2'].artwork).toBeNull()
      expect(by['book-small'].artwork).toBe(SMALL)       // under threshold: untouched
      expect(getAll<{ entity_id: string }>(db, 'SELECT entity_id FROM sync_queue ORDER BY entity_id'))
        .toEqual([{ entity_id: 'book-fat' }, { entity_id: 'book-fat-2' }])
    })

    it('leaves artwork alone when re-encoding does not shrink it', async () => {
      const db = await seededV12()

      await migrations[13](db, { metadata: { downscaleArtwork: async (uri: string) => uri } })

      const by = artworkRows(db)
      expect(by['book-fat']).toMatchObject({ artwork: FAT, updated_at: 42 })
      expect(getAll(db, 'SELECT * FROM sync_queue')).toEqual([])
    })
  })

  it('recovers when migration 0 failed after recording itself', async () => {
    // Migrations must rerun fully after a mid-way failure (CLAUDE.md rule),
    // but migration 0 records itself in status BEFORE creating the rest of
    // the schema. If a later statement in it fails, the next launch resumes
    // at migration 1 against a half-created schema — and, since v1.6.3
    // swallows migration errors, fails silently on every launch forever.
    const db = createTestDatabase()
    db.execSync(`
      CREATE TABLE IF NOT EXISTS status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        migration INTEGER NOT NULL
      )
    `)
    db.runSync('INSERT INTO status (id, migration) VALUES (1, 0)')

    const service = new DatabaseService(db)
    await service.migrate(testMigrationDeps)

    const tables = getAll<{ name: string }>(
      db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('files', 'clips', 'sessions')"
    )
    expect(tables).toHaveLength(3)
  })

  it('upgrades a populated v7 database to latest without loss or crash', async () => {
    const db = await dbAtVersion(7)
    db.runSync("INSERT INTO files (id, uri, name, title, position) VALUES ('book-1', 'file:///a/book-1.mp3', 'Book.mp3', 'A Book', 5000)")
    db.runSync("INSERT INTO clips (id, source_id, uri, start, duration, note, created_at, updated_at) VALUES ('clip-1', 'book-1', 'file:///c/clip-1.m4a', 100, 2000, 'a note', 1, 1)")
    db.runSync("INSERT INTO sessions (id, book_id, started_at, ended_at) VALUES ('sess-1', 'book-1', 10, 20)")

    // Running the real service applies every pending migration to the old data.
    const service = new DatabaseService(db)
    await service.migrate(testMigrationDeps)

    const book = await service.getBookById('book-1')
    expect(book).not.toBeNull()
    expect(book!.position).toBe(5000)   // pre-existing data preserved
    expect(book!.speed).toBe(100)       // column added by a later migration, defaulted

    const [clip] = await service.getAllClips()
    expect(clip.id).toBe('clip-1')
    expect(clip.note).toBe('a note')
    expect(clip.source_title).toBe('A Book')  // backfilled during upgrade

    expect(service.getSettings().clip_editor_linked).toBe(true) // migration 10 default
  })
})
