import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { LATEST_MIGRATION, VERSIONS, baselineLibrary, scenariosOf } from '../upgrade_scenarios'
import type { SeedContext, VerifyContext } from '../upgrade_scenarios'
import { DatabaseService, migrations } from '../../src/services/storage/database'
import {
  createMemoryArtworkStore, createTestDatabase, testMigrationDeps,
} from '../../src/services/storage/__tests__/sqlite_adapter'

describe('upgrade scenarios', () => {
  it('LATEST_MIGRATION mirrors the migrations array', () => {
    expect(LATEST_MIGRATION).toBe(migrations.length - 1)
  })

  // MIGRATIONS.md rule: every data-transforming migration is exercised by an
  // upgrade scenario. Maintained by hand — append the index when writing such
  // a migration. Only migrations above the oldest live version need one:
  // below it, no user can still cross them.
  const DATA_TRANSFORMING = [8, 12, 13, 14]

  const floor = Math.min(...VERSIONS.map(v => v.migration))
  const uncrossed = DATA_TRANSFORMING.filter(m => m > floor)

  it.each(uncrossed.length ? uncrossed : [null])('data-transforming migration %s is crossed by a scenario', (index) => {
    if (index === null) return // every live version is past every data-transforming migration
    const covered = VERSIONS.some(v => v.migration < index && scenariosOf(v).some(s => s.migrations?.includes(index)))
    expect(covered).toBe(true)
  })

  it('versions are unique, tagged, and not ahead of the current build', () => {
    const names = VERSIONS.map(v => v.name)
    expect(new Set(names).size).toBe(names.length)
    const tags = execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' }).split('\n')
    for (const version of VERSIONS) {
      expect(tags).toContain(version.name)
      expect(version.migration).toBeLessThanOrEqual(LATEST_MIGRATION)
    }
  })

  it('every version seeds the baseline library', () => {
    for (const version of VERSIONS) expect(scenariosOf(version)).toContain(baselineLibrary)
  })

  // Dry run without a device: seed each version's scenarios into a jest DB at
  // its migration index, migrate to latest, verify. Catches SQL typos and
  // seed/verify drift in seconds; the device run (`test --upgrade`) stays the
  // real check (actual base builds, native file writes).
  it.each(VERSIONS.map(v => [v.name, v] as const))('%s scenarios pass against jest-migrated data', async (_, version) => {
    const raw = createTestDatabase()
    for (let i = 0; i <= version.migration; i++) {
      await migrations[i](raw, testMigrationDeps)
      raw.runSync('UPDATE status SET migration = ? WHERE id = 1', [i])
    }

    const unsupported = () => { throw new Error('device-only in the dry run') }
    const seedCtx: SeedContext = {
      base: version.name,
      root: path.resolve(__dirname, '../..'),
      appDir: '/app',
      sql: statements => raw.execSync(statements),
      hasColumn: (table, column) =>
        raw.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`).some(c => c.name === column),
      shell: unsupported,
      pushFile: unsupported,
    }
    for (const scenario of scenariosOf(version)) scenario.seed(seedCtx)

    const artwork = createMemoryArtworkStore()
    await new DatabaseService(raw).migrate({ ...testMigrationDeps, artwork })

    const failures: string[] = []
    const verifyCtx: VerifyContext = {
      appDir: '/app',
      // sqlite3 CLI rendering: NULL prints as empty
      query: sql => String(Object.values(raw.getFirstSync<Record<string, unknown>>(sql) ?? {})[0] ?? ''),
      shell: unsupported,
      fileSize: devicePath => {
        const content = artwork.files.get(path.posix.basename(devicePath))
        return devicePath.startsWith('/app/files/artwork/') && content !== undefined
          ? Buffer.from(content, 'base64').length
          : null
      },
      expect: (desc, got, want) => { if (String(got) !== String(want)) failures.push(`${desc}: got '${got}', expected '${want}'`) },
    }
    for (const scenario of scenariosOf(version)) scenario.verify(verifyCtx)

    expect(failures).toEqual([])
  })
})
