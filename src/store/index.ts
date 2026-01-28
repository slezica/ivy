import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import * as services from '../services'

import { createClipSlice } from './clips'
import { createPlaybackSlice } from './playback'
import { createLibrarySlice } from './library'
import { createTranscriptionSlice } from './transcription'
import { createSyncSlice } from './sync'
import { createSettingsSlice } from './settings'
import { createSessionSlice } from './session'
import type { AppState } from './types'


export const useStore = create<AppState>()(immer((set, get) => {
  const deps = {...services}
  const { db, transcription, audio } = services // TODO this seems like broken layering
  
  // Start transcription service if enabled in settings
  const initialSettings = db.getSettings()
  if (initialSettings.transcription_enabled) {
    transcription.start()
  }

  // Slices ----------------------------------------------------------------------------------------

  const librarySlice = createLibrarySlice(deps)
  const playbackSlice = createPlaybackSlice(deps)
  const clipSlice = createClipSlice(deps)
  const transcriptionSlice = createTranscriptionSlice(deps)
  const syncSlice = createSyncSlice(deps)
  const settingsSlice = createSettingsSlice(deps)
  const sessionSlice = createSessionSlice(deps)

  return {
    ...librarySlice(set, get),
    ...playbackSlice(set, get),
    ...clipSlice(set, get),
    ...transcriptionSlice(set, get),
    ...syncSlice(set, get),
    ...settingsSlice(set, get),
    ...sessionSlice(set, get),
    __DEV_resetApp,
  }

  // Development -----------------------------------------------------------------------------------

  async function __DEV_resetApp() {
    await audio.unload()
    db.clearAllData()

    set({
      library: { status: 'idle' },
      playback: {
        status: 'idle',
        position: 0,
        uri: null,
        duration: 0,
        ownerId: null,
      },
      sync: {
        isSyncing: false,
        pendingCount: 0,
        lastSyncTime: null,
        error: null,
      },
      clips: {},
      transcription: { status: 'idle', pending: {} },
      books: {},
      sessions: [],
      settings: { sync_enabled: false, transcription_enabled: true },
    })

    console.log('App reset complete')
  }
}))

// Re-export types for consumers
export type { AppState } from './types'
