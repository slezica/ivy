import { execFileSync } from 'node:child_process'
import { LATEST_MIGRATION, VERSIONS, baselineLibrary, scenariosOf } from '../upgrade_scenarios'
import { migrations } from '../../src/services/storage/database'

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
})
