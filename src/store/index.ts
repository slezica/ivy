import { create } from 'zustand'

import {
  // Service classes
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
  OfflineQueueService,
  BackupSyncService,
  SharingService,
} from '../services'

import type { Settings } from '../services'
import { createClipSlice } from './clips'
import { createPlaybackSlice } from './playback'
import { createLibrarySlice } from './library'
import { createSyncSlice } from './sync'
import type { AppState, PlaybackContext } from './types'

const POSITION_SYNC_THROTTLE_MS = 30 * 1000  // Only queue position sync every 30s


export const useStore = create<AppState>((set, get) => {
  // ---------------------------------------------------------------------------
  // Service Wiring
  //
  // All services are created here with explicit dependencies.
  // Services are encapsulated - UI components access them only via store actions.
  // ---------------------------------------------------------------------------

  // Track last queue time for position updates (throttling)
  let lastPositionQueueTime = 0

  // Note: fetchBooks is defined below via function declaration and is hoisted.
  // Clip actions are accessed via get() since they come from the clip slice.

  // === Foundation Layer (no dependencies) ===
  const dbService = new DatabaseService()
  const fileStorageService = new FileStorageService()
  const filePickerService = new FilePickerService()
  const metadataService = new AudioMetadataService()
  const slicerService = new AudioSlicerService()
  const whisperService = new WhisperService()
  const sharingService = new SharingService()

  // === Auth Layer ===
  const authService = new GoogleAuthService()

  // === Services with dependencies ===
  const driveService = new GoogleDriveService(authService)
  const queueService = new OfflineQueueService(dbService)

  const syncService = new BackupSyncService(
    dbService,
    driveService,
    authService,
    queueService,
    {
      onStatusChange: (status) => {
        set((state) => ({
          sync: {
            ...status,
            // Preserve lastSyncTime from our state (service doesn't track it)
            // Refresh it from DB when sync completes
            lastSyncTime: status.isSyncing ? state.sync.lastSyncTime : dbService.getLastSyncTime(),
          },
        }))
      },
      onDataChange: (notification) => {
        if (notification.booksChanged.length > 0) {
          get().fetchBooks()
        }
        if (notification.clipsChanged.length > 0) {
          get().fetchClips()
        }
      },
    }
  )

  const transcriptionService = new TranscriptionQueueService({
    database: dbService,
    whisper: whisperService,
    slicer: slicerService,
    onTranscriptionComplete: (clipId, transcription) => {
      const { clips } = get()
      if (clips[clipId]) {
        set((state) => ({
          clips: {
            ...state.clips,
            [clipId]: {
              ...state.clips[clipId],
              transcription,
              updated_at: Date.now(),
            },
          },
        }))
      }
    },
  })

  // Start transcription service
  transcriptionService.start()

  const audioService = new AudioPlayerService({
    onPlaybackStatusChange: (status) => {
      set((state) => ({
        playback: {
          ...state.playback,
          // Only update status if not currently in a transitional state
          status: state.playback.status === 'loading'
            ? state.playback.status
            : status.status,
          position: status.position,
        },
      }))

      // Update book position in database
      // Only if we have a file loaded and valid position
      const { playback, books } = get()
      if (playback.uri && status.position >= 0 && status.duration > 0) {
        const book = Object.values(books).find(b => b.uri === playback.uri)
        if (book) {
          dbService.updateBookPosition(book.id, status.position)

          // Throttle queue updates - only sync position every 30 seconds
          const now = Date.now()
          if (now - lastPositionQueueTime > POSITION_SYNC_THROTTLE_MS) {
            lastPositionQueueTime = now
            queueService.queueChange('book', book.id, 'upsert')
          }
        }
      }
    },
  })

  // ---------------------------------------------------------------------------
  // Slices
  // ---------------------------------------------------------------------------

  const librarySlice = createLibrarySlice({
    db: dbService,
    files: fileStorageService,
    picker: filePickerService,
    metadata: metadataService,
    audio: audioService,
    queue: queueService,
  })(set, get)

  const playbackSlice = createPlaybackSlice({
    audio: audioService,
    db: dbService,
  })(set, get)

  const clipSlice = createClipSlice({
    db: dbService,
    slicer: slicerService,
    queue: queueService,
    transcription: transcriptionService,
    sharing: sharingService,
  })(set, get)

  const syncSlice = createSyncSlice({
    db: dbService,
    sync: syncService,
  })(set, get)

  return {
    // Initial state
    settings: dbService.getSettings(),

    // Slices
    ...librarySlice,
    ...playbackSlice,
    ...clipSlice,
    ...syncSlice,

    // Actions (below)
    updateSettings,
    __DEV_resetApp
  }

  function updateSettings(settings: Settings) {
    dbService.setSettings(settings)
    set({ settings })
  }

  async function __DEV_resetApp() {
    // Unload current player
    await audioService.unload()

    // Clear database
    dbService.clearAllData()

    // Reset store state
    set({
      library: {
        status: 'idle',
      },
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
})

// Re-export types for consumers
export type { AppState, PlaybackContext } from './types'
