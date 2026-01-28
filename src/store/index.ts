import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import type { PlaybackStatus, SyncStatus, SyncNotification } from '../services'
import * as services from '../services'
import { TranscriptionQueueEvents } from '../services/transcription/queue'
import { MAIN_PLAYER_OWNER_ID, throttle } from '../utils'
import type { AppState } from './types'

// Action factories
import { createFetchBooks } from '../actions/fetch_books'
import { createFetchClips } from '../actions/fetch_clips'
import { createLoadFile } from '../actions/load_file'
import { createLoadFileWithUri } from '../actions/load_file_with_uri'
import { createLoadFileWithPicker } from '../actions/load_file_with_picker'
import { createArchiveBook } from '../actions/archive_book'
import { createDeleteBook } from '../actions/delete_book'
import { createPlay } from '../actions/play'
import { createPause } from '../actions/pause'
import { createSeek } from '../actions/seek'
import { createSeekClip } from '../actions/seek_clip'
import { createSkipForward } from '../actions/skip_forward'
import { createSkipBackward } from '../actions/skip_backward'
import { createSyncPlaybackState } from '../actions/sync_playback_state'
import { createAddClip } from '../actions/add_clip'
import { createUpdateClip } from '../actions/update_clip'
import { createDeleteClip } from '../actions/delete_clip'
import { createShareClip } from '../actions/share_clip'
import { createStartTranscription } from '../actions/start_transcription'
import { createStopTranscription } from '../actions/stop_transcription'
import { createSyncNow } from '../actions/sync_now'
import { createAutoSync } from '../actions/auto_sync'
import { createRefreshSyncStatus } from '../actions/refresh_sync_status'
import { createUpdateSettings } from '../actions/update_settings'
import { createFetchSessions } from '../actions/fetch_sessions'
import { createTrackSession } from '../actions/track_session'
import { createFinalizeSession } from '../actions/finalize_session'
import { createResetApp } from '../actions/reset_app'


export const useStore = create<AppState>()(immer((set, get) => {
  const { db, files, picker, metadata, audio, slicer, syncQueue, transcription, sharing, sync } = services

  // Start transcription service if enabled in settings
  const initialSettings = db.getSettings()
  if (initialSettings.transcription_enabled) {
    transcription.start()
  }

  // Throttled helpers
  const queuePositionSync = throttle((bookId: string) => {
    syncQueue.queueChange('book', bookId, 'upsert')
  }, 30_000)

  const throttledTrackSession = throttle((bookId: string) => {
    trackSession(bookId)
  }, 5_000)

  // Actions ---------------------------------------------------------------------------------------

  // Library
  const fetchBooks = createFetchBooks({ db, set })
  const fetchClips = createFetchClips({ db, set })
  const archiveBook = createArchiveBook({ db, files, syncQueue, set, get })
  const deleteBook = createDeleteBook({ db, files, syncQueue, set, get })
  const loadFile = createLoadFile({ db, files, metadata, syncQueue, set, fetchBooks, fetchClips })
  const loadFileWithUri = createLoadFileWithUri({ loadFile })
  const loadFileWithPicker = createLoadFileWithPicker({ picker, loadFile })

  // Playback
  const play = createPlay({ audio, db, set, get })
  const pause = createPause({ audio, set })
  const seek = createSeek({ audio, set, get })
  const seekClip = createSeekClip({ get, play })
  const skipForward = createSkipForward({ audio })
  const skipBackward = createSkipBackward({ audio })
  const syncPlaybackState = createSyncPlaybackState({ audio, set })

  // Clips
  const updateClip = createUpdateClip({ db, slicer, syncQueue, transcription, set, get })
  const deleteClip = createDeleteClip({ db, slicer, syncQueue, set, get })
  const shareClip = createShareClip({ sharing, get })
  const addClip = createAddClip({ db, slicer, syncQueue, transcription, get, fetchClips })

  // Transcription
  const startTranscription = createStartTranscription({ transcription })
  const stopTranscription = createStopTranscription({ transcription, set })

  // Sync
  const syncNow = createSyncNow({ sync })
  const autoSync = createAutoSync({ sync, get })
  const refreshSyncStatus = createRefreshSyncStatus({ db, sync, set })

  // Settings
  const updateSettings = createUpdateSettings({ db, set })

  // Sessions
  const fetchSessions = createFetchSessions({ db, set })
  const trackSession = createTrackSession({ db, set, get })
  const finalizeSession = createFinalizeSession({ db, set })

  // Dev
  const __DEV_resetApp = createResetApp({ db, audio, set })

  // Event listeners -------------------------------------------------------------------------------

  audio.on('status', (status: PlaybackStatus) => {
    // Update playback state
    set((state) => {
      if (state.playback.status !== 'loading') {
        state.playback.status = status.status
      }
      state.playback.position = status.position
    })

    // Update book position in database
    const { playback, books } = get()
    if (!playback.uri || status.position < 0 || status.duration <= 0) return
    if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

    const book = Object.values(books).find(b => b.uri === playback.uri)
    if (!book) return

    db.updateBookPosition(book.id, status.position)
    queuePositionSync(book.id)

    // Track listening sessions
    const { currentSessionBookId } = get()

    if (status.status === 'playing') {
      if (!book || status.position < 0 || status.duration <= 0) return
      set((state) => { state.currentSessionBookId = book.id })
      throttledTrackSession(book.id)
    } else if (currentSessionBookId) {
      finalizeSession(currentSessionBookId)
      set((state) => { state.currentSessionBookId = null })
    }
  })

  sync.on('status', (status: SyncStatus) => {
    set((state) => {
      state.sync = {
        ...status,
        lastSyncTime: status.isSyncing ? state.sync.lastSyncTime : db.getLastSyncTime(),
      }
    })
  })

  sync.on('data', (notification: SyncNotification) => {
    if (notification.booksChanged.length > 0) {
      fetchBooks()
    }
    if (notification.clipsChanged.length > 0) {
      fetchClips()
    }
  })

  transcription.on('queued', ({ clipId }: TranscriptionQueueEvents['queued']) => {
    set(state => {
      state.transcription.pending[clipId] = true
    })
  })

  transcription.on('finish', ({ clipId, error, transcription }: TranscriptionQueueEvents['finish']) => {
    if (error) {
      console.error(error)
    }

    set(state => {
      delete state.transcription.pending[clipId]
    })

    if (transcription) {
      updateClip(clipId, { transcription })
    }
  })

  transcription.on('status', ({ status }: TranscriptionQueueEvents['status']) => {
    set(state => {
      state.transcription.status = status
    })
  })

  // Initial state ---------------------------------------------------------------------------------

  return {
    // Library
    library: { status: 'loading' },
    books: {},
    fetchBooks,
    loadFile,
    loadFileWithUri,
    loadFileWithPicker,
    archiveBook,
    deleteBook,

    // Playback
    playback: {
      status: 'idle',
      ownerId: null,
      uri: null,
      position: 0,
      duration: 0,
    },
    play,
    pause,
    seek,
    seekClip,
    skipForward,
    skipBackward,
    syncPlaybackState,

    // Clips
    clips: {},
    fetchClips,
    addClip,
    updateClip,
    deleteClip,
    shareClip,

    // Transcription
    transcription: {
      status: 'idle',
      pending: {},
    },
    startTranscription,
    stopTranscription,

    // Sync
    sync: {
      isSyncing: false,
      pendingCount: sync.getPendingCount(),
      lastSyncTime: db.getLastSyncTime(),
      error: null,
    },
    syncNow,
    autoSync,
    refreshSyncStatus,

    // Settings
    settings: db.getSettings(),
    updateSettings,

    // Sessions
    sessions: db.getAllSessions(),
    currentSessionBookId: null,
    fetchSessions,
    trackSession,

    // Dev
    __DEV_resetApp,
  }
}))

// Re-export types for consumers
export type { AppState } from './types'
