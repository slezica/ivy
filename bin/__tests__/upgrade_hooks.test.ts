import { LATEST_MIGRATION, UPGRADE_HOOKS } from '../upgrade_hooks'
import { migrations } from '../../src/services/storage/database'

describe('upgrade hooks', () => {
  it('LATEST_MIGRATION mirrors the migrations array', () => {
    expect(LATEST_MIGRATION).toBe(migrations.length - 1)
  })

  // MIGRATIONS.md rule: every data-transforming migration gets an upgrade
  // hook (pure ADD COLUMN migrations need none). Maintained by hand — append
  // the index when writing such a migration. Migration 8 predates the hook
  // system and its upgrade window has long shipped.
  const DATA_TRANSFORMING = [12, 13]

  it.each(DATA_TRANSFORMING)('data-transforming migration %i has an upgrade hook', (index) => {
    expect(UPGRADE_HOOKS.some(h => h.migration === index)).toBe(true)
  })
})
