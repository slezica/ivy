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
  type PlaybackStatus,
} from '../services'

import { createClipSlice } from './clips'
import { createPlaybackSlice } from './playback'
import { createLibrarySlice } from './library'
import { createSyncSlice } from './sync'
import { createSettingsSlice } from './settings'
import { createSessionSlice } from './session'
import type { AppState, PlaybackContext } from './types'
import { MAIN_PLAYER_OWNER_ID, throttle } from '../utils'


export const useStore = create<AppState>()(immer((set, get) => {

  // Services -------------------------------------------------------------------------------------- 

  const db = new DatabaseService()
  const files = new FileStorageService()
  const picker = new FilePickerService()
  const metadata = new AudioMetadataService()
  const slicer = new AudioSlicerService()
  const whisper = new WhisperService()
  const sharing = new SharingService()

  const auth = new GoogleAuthService()

  const drive = new GoogleDriveService(auth)
  const syncQueue = new SyncQueueService(db)

  const sync = new BackupSyncService(db, drive, auth, syncQueue)
  sync.on('status', onSyncStatusChange)
  sync.on('data', onSyncDataChange)

  const transcription = new TranscriptionQueueService({ database: db, whisper, slicer })
  transcription.on('complete', onTranscriptionComplete)
  transcription.start()

  const audio = new AudioPlayerService()
  audio.on('status', onPlaybackStatusChange)

  // Slices ----------------------------------------------------------------------------------------

  const librarySlice = createLibrarySlice({ db, files, picker, metadata, syncQueue })
  const playbackSlice = createPlaybackSlice({ audio, db })
  const clipSlice = createClipSlice({ db, slicer, syncQueue, transcription, sharing })
  const syncSlice = createSyncSlice({ db, sync })
  const settingsSlice = createSettingsSlice({ db })
  const sessionSlice = createSessionSlice({ db })

  return {
    ...librarySlice(set, get),
    ...playbackSlice(set, get),
    ...clipSlice(set, get),
    ...syncSlice(set, get),
    ...settingsSlice(set, get),
    ...sessionSlice(set, get),
    __DEV_resetApp,
  }

  // Listeners -------------------------------------------------------------------------------------

  function onSyncStatusChange(status: { isSyncing: boolean; pendingCount: number; error: string | null }) {
    set((state) => {
      state.sync = {
        ...status,
        // Preserve lastSyncTime from our state (service doesn't track it)
        // Refresh it from DB when sync completes
        lastSyncTime: status.isSyncing ? state.sync.lastSyncTime : db.getLastSyncTime(),
      }
    })
  }

  function onSyncDataChange(notification: { booksChanged: string[]; clipsChanged: string[] }) {
    if (notification.booksChanged.length > 0) {
      get().fetchBooks()
    }
    if (notification.clipsChanged.length > 0) {
      get().fetchClips()
    }
  }

  function onTranscriptionComplete({ clipId, transcription }: { clipId: string; transcription: string }) {
    get().updateClip(clipId, { transcription })
  }

  // Throttled operations for playback updates
  const queuePositionSync = throttle((bookId: string) => {
    syncQueue.queueChange('book', bookId, 'upsert')
  }, 30_000)

  const trackSession = throttle((bookId: string) => {
    get().trackSession(bookId)
  }, 5_000)

  function onPlaybackStatusChange(status: PlaybackStatus) {
    set((state) => {
      // Only update status if not currently in a transitional state
      if (state.playback.status !== 'loading') {
        state.playback.status = status.status
      }
      state.playback.position = status.position
    })

    // Update book position in database (only if we have valid playback)
    const { playback, books } = get()
    if (!playback.uri || status.position < 0 || status.duration <= 0) return

    // Only track sessions for main player (not clips)
    if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

    const book = Object.values(books).find(b => b.uri === playback.uri)
    if (!book) return

    db.updateBookPosition(book.id, status.position)
    queuePositionSync(book.id)

    if (status.status === 'playing') {
      trackSession(book.id)
    }
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
export type { AppState, PlaybackContext } from './types'
