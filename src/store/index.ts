import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import {
  DatabaseService,
  FileStorageService,
  FilePickerService,
  AudioPlayerService,
  AudioMetadataService,
  AudioSlicerService,
  WhisperService,
  TranscriptionQueueService,
  GoogleAuthService,
  GoogleDriveService,
  SyncQueueService,
  BackupSyncService,
  SharingService,
} from '../services'

import { createClipSlice } from './clips'
import { createPlaybackSlice } from './playback'
import { createLibrarySlice } from './library'
import { createSyncSlice } from './sync'
import { createSettingsSlice } from './settings'
import { createSessionSlice } from './session'
import type { AppState } from './types'


export const useStore = create<AppState>()(immer((set, get) => {

  // Services --------------------------------------------------------------------------------------

  const db = new DatabaseService()
  const files = new FileStorageService()
  const picker = new FilePickerService()
  const metadata = new AudioMetadataService()
  const slicer = new AudioSlicerService()
  const whisper = new WhisperService()
  const sharing = new SharingService()
  const audio = new AudioPlayerService()

  const auth = new GoogleAuthService()
  const drive = new GoogleDriveService(auth)
  const syncQueue = new SyncQueueService(db)
  const sync = new BackupSyncService(db, drive, auth, syncQueue)

  const transcription = new TranscriptionQueueService({ database: db, whisper, slicer })
  transcription.start()

  // Slices ----------------------------------------------------------------------------------------

  const librarySlice = createLibrarySlice({ db, files, picker, metadata, audio, syncQueue, sync })
  const playbackSlice = createPlaybackSlice({ audio, db })
  const clipSlice = createClipSlice({ db, slicer, syncQueue, transcription, sharing, sync })
  const syncSlice = createSyncSlice({ db, sync })
  const settingsSlice = createSettingsSlice({ db })
  const sessionSlice = createSessionSlice({ db, audio })

  return {
    ...librarySlice(set, get),
    ...playbackSlice(set, get),
    ...clipSlice(set, get),
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
      books: {},
      settings: { sync_enabled: false },
    })

    console.log('App reset complete')
  }
}))

// Re-export types for consumers
export type { AppState } from './types'
