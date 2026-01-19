/**
 * Settings Slice
 *
 * State and actions for app settings.
 */

import type { DatabaseService, Settings } from '../services'
import type { SettingsSlice, SetState, GetState } from './types'

// =============================================================================
// Types
// =============================================================================

/** Dependencies required by this slice */
export interface SettingsSliceDeps {
  db: DatabaseService
}

// =============================================================================
// Slice Creator
// =============================================================================

export function createSettingsSlice(deps: SettingsSliceDeps) {
  const { db } = deps

  return (set: SetState, get: GetState): SettingsSlice => {
    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

    function updateSettings(settings: Settings): void {
      db.setSettings(settings)
      set({ settings })
    }

    // -----------------------------------------------------------------
    // Return slice
    // -----------------------------------------------------------------

    return {
      // Initial state
      settings: db.getSettings(),

      // Actions
      updateSettings,
    }
  }
}
