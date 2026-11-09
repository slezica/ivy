// Upgrade scenarios for the upgrade test (`bin/ivy.ts test --upgrade`).
// Design: docs/2026-09-28-upgrade-scenarios.md. Re-read before each release.
//
// We test APP upgrades from the versions users still run, not migrations.
//
// - A Scenario is one interesting situation: seed() produces it on an old
//   build (always the same semantic state, however it gets there), verify()
//   checks it after upgrading to the current build.
// - A Version is a release users still run (Play Console: install base by app
//   version). Its seed() lists the scenarios its app could have produced;
//   the run verifies exactly those.
//
// Rules:
// - A version seeds only states its app could have produced. Seeds bypass
//   the app, so a pre-migration-X state seeded into a post-X base is
//   impossible and fails verify for no real reason.
// - Seeds are stable; verifies follow the current schema. When a migration
//   changes how data is represented, update the affected verifies in the
//   same commit, keeping the invariant.
// - Drop a version when nobody runs it, then drop scenarios no version seeds.
//   Git keeps them.

import fs from 'node:fs'
import path from 'node:path'

/** Bump when appending a migration (mirrors migrations.length - 1 in
 * src/services/storage/database.ts — the toolkit can't import that module). */
export const LATEST_MIGRATION = 14

/** Seeding runs while the old build is stopped: sql() edits a pulled copy of
 * its DB (pushed back after all seeds), device-side calls act immediately. */
export interface SeedContext {
  base: string                                  // version name being seeded, e.g. 'v1.6.5'
  root: string                                  // repo root, for fixtures
  appDir: string                                // app's private dir on device (/data/data/<pkg>)
  sql(statements: string): void
  hasColumn(table: string, column: string): boolean
  shell(...args: string[]): string              // adb shell, as root
  pushFile(local: string, devicePath: string): void  // into app storage, owned by the app
}

/** Verifying runs after the current build migrated and was stopped. */
export interface VerifyContext {
  appDir: string
  query(sql: string): string                    // single value, trimmed
  shell(...args: string[]): string              // adb shell, as root
  fileSize(devicePath: string): number | null   // null when missing
  expect(desc: string, got: unknown, want: unknown): void  // records pass/fail, never throws
}

export interface Scenario {
  description: string
  /** Data-transforming migrations this scenario exercises (coverage guard). */
  migrations?: number[]
  seed(ctx: SeedContext): void
  verify(ctx: VerifyContext): void
}

export interface Version {
  name: string        // release tag; base APK is cache/upgrade/ivy-maestro-<name without v>.apk
  migration: number   // the base's migration index (asserted at runtime)
  seed(run: (scenario: Scenario) => void): void
}

// ---------------------------------------------------------------------------
// Scenarios

// A small library every version has: a book with a clip and a session.
// Upgrades must keep it intact and queue nothing for sync (per-device
// normalizations touch nothing; a converging repair that queues these rows
// would update this verify).
const BASE_BOOK = 'upgrade-base-book'
const BASE_CLIP = 'upgrade-base-clip'
const BASE_SESSION = 'upgrade-base-session'

export const baselineLibrary: Scenario = {
  description: 'baseline library survives, nothing queued',
  seed(ctx) {
    ctx.sql(`
      INSERT INTO files (id, uri, name, duration, position, updated_at)
      VALUES ('${BASE_BOOK}', 'file:///audio/upgrade-base.m4a', 'upgrade-base.m4a', 60000, 12345, 1);
      INSERT INTO clips (id, source_id, uri, start, duration, note, created_at, updated_at)
      VALUES ('${BASE_CLIP}', '${BASE_BOOK}', 'file:///clips/upgrade-base.m4a', 0, 1000, 'upgrade baseline note', 1, 1);
      INSERT INTO sessions (id, book_id, started_at, ended_at)
      VALUES ('${BASE_SESSION}', '${BASE_BOOK}', 10, 20);
    `)
  },
  verify(ctx) {
    ctx.expect('book position survives', ctx.query(`SELECT position FROM files WHERE id = '${BASE_BOOK}'`), '12345')
    ctx.expect('clip note survives', ctx.query(`SELECT note FROM clips WHERE id = '${BASE_CLIP}'`), 'upgrade baseline note')
    ctx.expect('session survives', ctx.query(`SELECT ended_at FROM sessions WHERE id = '${BASE_SESSION}'`), '20')
    ctx.expect('nothing queued for sync', ctx.query('SELECT count(*) FROM sync_queue'), '0')
  },
}

// Books with covers stored as base64 data URIs (every version before 14):
// migration 14 moves them to files in <documents>/artwork/, leaving only the
// filename on the row (docs/2026-09-28-artwork-as-files.md). A JPEG (what
// extraction produces), a PNG (what demo seeds produce) and a coverless book.
const COVER_JPEG_BOOK = 'upgrade-cover-jpeg'
const COVER_PNG_BOOK = 'upgrade-cover-png'
const COVER_NONE_BOOK = 'upgrade-cover-none'
const COVER_JPEG_FIXTURE = 'assets/test/test-artwork.jpg'
// 4x4 RGB PNG
const COVER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGPQqzWCIwbiOABnIw3R2yR41wAAAABJRU5ErkJggg=='

export const libraryWithCovers: Scenario = {
  description: 'covers move from the DB to files',
  migrations: [14],
  seed(ctx) {
    const jpeg = fs.readFileSync(path.join(ctx.root, COVER_JPEG_FIXTURE)).toString('base64')
    const book = (id: string, artwork: string | null) => `
      INSERT INTO files (id, uri, name, duration, position, updated_at, artwork)
      VALUES ('${id}', 'file:///audio/${id}.m4a', '${id}.m4a', 60000, 0, 1, ${artwork ? `'${artwork}'` : 'NULL'});`
    ctx.sql([
      book(COVER_JPEG_BOOK, `data:image/jpeg;base64,${jpeg}`),
      book(COVER_PNG_BOOK, `data:image/png;base64,${COVER_PNG_BASE64}`),
      book(COVER_NONE_BOOK, null),
    ].join('\n'))
  },
  verify(ctx) {
    const covers: [string, string, number][] = [
      [COVER_JPEG_BOOK, 'jpg', fs.statSync(path.join(__dirname, '..', COVER_JPEG_FIXTURE)).size],
      [COVER_PNG_BOOK, 'png', Buffer.from(COVER_PNG_BASE64, 'base64').length],
    ]
    for (const [id, ext, size] of covers) {
      const file = ctx.query(`SELECT artwork_file FROM files WHERE id = '${id}'`)
      ctx.expect(`${ext} cover filename`, new RegExp(`^${id}\\.[0-9a-f]{4}\\.${ext}$`).test(file), true)
      ctx.expect(`${ext} cover file has the exact bytes`, ctx.fileSize(`${ctx.appDir}/files/artwork/${file}`), size)
      ctx.expect(`${ext} cover base64 cleared`, ctx.query(`SELECT artwork IS NULL FROM files WHERE id = '${id}'`), '1')
      ctx.expect(`${ext} cover row not bumped`, ctx.query(`SELECT updated_at FROM files WHERE id = '${id}'`), '1')
    }
    ctx.expect('coverless book has no file', ctx.query(`SELECT artwork_file IS NULL FROM files WHERE id = '${COVER_NONE_BOOK}'`), '1')
  },
}

// ---------------------------------------------------------------------------
// Versions users still run — Play Console, 2026-09-28: v1.6.4, v1.6.5, plus
// v1.6.6 (alpha, heading to production). All at migration 13.

export const VERSIONS: Version[] = [
  {
    name: 'v1.6.4',
    migration: 13,
    seed(run) {
      run(baselineLibrary)
      run(libraryWithCovers)
    },
  },
  {
    name: 'v1.6.5',
    migration: 13,
    seed(run) {
      run(baselineLibrary)
      run(libraryWithCovers)
    },
  },
  {
    name: 'v1.6.6',
    migration: 13,
    seed(run) {
      run(baselineLibrary)
      run(libraryWithCovers)
    },
  },
]

/** The scenarios a version seeds, in call order. */
export function scenariosOf(version: Version): Scenario[] {
  const seeded: Scenario[] = []
  version.seed(scenario => seeded.push(scenario))
  return seeded
}
