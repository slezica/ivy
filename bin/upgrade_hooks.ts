// Per-migration hooks for the upgrade smoke test (`bin/ivy.ts test --upgrade`).
//
// Each hook belongs to one migration: `seedSql` runs against the DB written by
// the PREVIOUS RELEASE's binary (its schema is frozen forever, so this code
// never rots), and `checks` run against the DB after the current build has
// migrated it. The runner selects hooks in range (old build's index, current]
// — see docs/MIGRATIONS.md and docs/2026-09-02-migration-testing.md.
//
// Hooks are kept forever, like migrations: they tell the story. Stale hooks
// are inert (their range never matches again). Write a hook for every
// DATA-TRANSFORMING migration; pure ADD COLUMN migrations need none.
//
// When several migrations ship in one release, ALL their seeds run against the
// previous-release schema — a later hook cannot use columns an earlier
// migration in the same batch added.

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Bump when appending a migration (mirrors migrations.length - 1 in
 * src/services/storage/database.ts — the toolkit can't import that module). */
export const LATEST_MIGRATION = 13

export interface UpgradeCheck {
  desc: string
  sql: string     // must produce a single value
  expect: string  // exact sqlite3 output
}

export interface UpgradeHook {
  migration: number
  description: string
  seedSql(root: string): string
  checks: UpgradeCheck[]
}

// ---------------------------------------------------------------------------
// Baseline: not a hook — seeded and checked on EVERY upgrade test, using only
// columns that have existed since the initial schema (safe against any base).

export function baselineSeedSql(): string {
  return `
    INSERT INTO files (id, uri, name, duration, position, updated_at)
    VALUES ('upgrade-base-book', 'file:///audio/upgrade-base.m4a', 'upgrade-base.m4a', 60000, 12345, 1);
    INSERT INTO clips (id, source_id, uri, start, duration, note, created_at, updated_at)
    VALUES ('upgrade-base-clip', 'upgrade-base-book', 'file:///clips/upgrade-base.m4a', 0, 1000, 'upgrade baseline note', 1, 1);
    INSERT INTO sessions (id, book_id, started_at, ended_at)
    VALUES ('upgrade-base-session', 'upgrade-base-book', 10, 20);
  `
}

export function baselineChecks(): UpgradeCheck[] {
  return [
    { desc: 'migration index is latest', sql: 'SELECT migration FROM status', expect: String(LATEST_MIGRATION) },
    { desc: 'baseline book survives', sql: "SELECT position FROM files WHERE id = 'upgrade-base-book'", expect: '12345' },
    { desc: 'baseline clip survives', sql: "SELECT note FROM clips WHERE id = 'upgrade-base-clip'", expect: 'upgrade baseline note' },
    { desc: 'baseline session survives', sql: "SELECT ended_at FROM sessions WHERE id = 'upgrade-base-session'", expect: '20' },
  ]
}

// ---------------------------------------------------------------------------
// Hooks

// Books seeded with pre-cap artwork sizes (>100KB base64) the way old versions
// stored them; one valid (gets downscaled by the real native decoder), one
// undecodable (gets dropped). Both must land in the sync outbox.
const artworkRepairHook: UpgradeHook = {
  migration: 13,
  description: 'artwork downscale repair',
  seedSql(root: string): string {
    // Real >512px JPEG, ~210KB as base64 — decodable by BitmapFactory
    const jpeg = fs.readFileSync(path.join(root, 'assets/test/test-artwork.jpg'))
    const valid = `data:image/jpeg;base64,${jpeg.toString('base64')}`
    // Valid base64 of 150KB of junk — not an image
    const corrupt = `data:image/jpeg;base64,${Buffer.alloc(150_000, 0x58).toString('base64')}`
    return `
      INSERT INTO files (id, uri, name, duration, position, updated_at, artwork)
      VALUES ('upgrade-fat-valid', 'file:///audio/fat-valid.m4a', 'fat-valid.m4a', 60000, 0, 1, '${valid}');
      INSERT INTO files (id, uri, name, duration, position, updated_at, artwork)
      VALUES ('upgrade-fat-corrupt', 'file:///audio/fat-corrupt.m4a', 'fat-corrupt.m4a', 60000, 0, 1, '${corrupt}');
    `
  },
  checks: [
    {
      desc: 'oversized valid artwork downscaled under the threshold',
      sql: "SELECT length(artwork) > 0 AND length(artwork) < 100000 FROM files WHERE id = 'upgrade-fat-valid'",
      expect: '1',
    },
    {
      desc: 'undecodable artwork dropped',
      sql: "SELECT artwork IS NULL FROM files WHERE id = 'upgrade-fat-corrupt'",
      expect: '1',
    },
    {
      desc: 'both repairs queued for sync',
      sql: "SELECT count(*) FROM sync_queue WHERE entity_type = 'book' AND entity_id IN ('upgrade-fat-valid', 'upgrade-fat-corrupt')",
      expect: '2',
    },
    {
      desc: 'baseline book (small artwork: none) untouched by the repair',
      sql: "SELECT count(*) FROM sync_queue WHERE entity_id = 'upgrade-base-book'",
      expect: '0',
    },
  ],
}

export const UPGRADE_HOOKS: UpgradeHook[] = [
  artworkRepairHook,
]
