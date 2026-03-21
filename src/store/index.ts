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
import { createCancelLoadFile } from '../actions/cancel_load_file'
import { createArchiveBook } from '../actions/archive_book'
import { createDeleteBook } from '../actions/delete_book'
import { createLoadBook } from '../actions/load_book'
import { createPlay } from '../actions/play'
import { createPause } from '../actions/pause'
import { createSeek } from '../actions/seek'
import { createSeekClip } from '../actions/seek_clip'
import { createSkipForward } from '../actions/skip_forward'
import { createSkipBackward } from '../actions/skip_backward'
import { createFetchPlaybackState } from '../actions/fetch_playback_state'
import { createAddClip } from '../actions/add_clip'
import { createUpdateClip } from '../actions/update_clip'
import { createDeleteClip } from '../actions/delete_clip'
import { createShareClip } from '../actions/share_clip'
import { createStartTranscription } from '../actions/start_transcription'
import { createStopTranscription } from '../actions/stop_transcription'
import { createSyncNow } from '../actions/sync_now'
import { createAutoSync } from '../actions/auto_sync'
import { createFetchSyncState } from '../actions/fetch_sync_state'
import { createUpdateSettings } from '../actions/update_settings'
import { createFetchSessions } from '../actions/fetch_sessions'
import { createTrackSession } from '../actions/track_session'
import { createFinalizeSession } from '../actions/finalize_session'
import { createUpdateBook } from '../actions/update_book'
import { createResetApp } from '../actions/reset_app'
import { createCleanupOrphanedFiles } from '../actions/cleanup_orphaned_files'
import { createLoadFromUrl } from '../actions/load_from_url'
import { createFetchDownloaderState } from '../actions/fetch_downloader_state'
import { createUpdateDownloader } from '../actions/update_downloader'


export const useStore = create<AppState>()(immer((set, get) => {
  const deps = { set, get, ...services}
  const { db, audio, files, syncQueue, transcription, sync } = services

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

  const fetchBooks = createFetchBooks(deps)
  const fetchClips = createFetchClips(deps)
  const archiveBook = createArchiveBook(deps)
  const deleteBook = createDeleteBook(deps)
  const updateBook = createUpdateBook(deps)
  const cleanupOrphanedFiles = createCleanupOrphanedFiles({ db, files })
  const loadFile = createLoadFile({ ...deps, fetchBooks, fetchClips, cleanupOrphanedFiles })
  const loadFileWithUri = createLoadFileWithUri({ ...deps, loadFile })
  const loadFileWithPicker = createLoadFileWithPicker({ ...deps, loadFile })
  const loadFromUrl = createLoadFromUrl({ ...deps, fetchBooks, fetchClips, cleanupOrphanedFiles })
  const cancelLoadFile = createCancelLoadFile(deps)
  const loadBook = createLoadBook(deps)
  const play = createPlay({ ...deps, loadBook })
  const pause = createPause(deps)
  const seek = createSeek(deps)
  const seekClip = createSeekClip({ ...deps, play })
  const skipForward = createSkipForward(deps)
  const skipBackward = createSkipBackward(deps)
  const fetchPlaybackState = createFetchPlaybackState(deps)
  const updateClip = createUpdateClip(deps)
  const deleteClip = createDeleteClip(deps)
  const shareClip = createShareClip(deps)
  const addClip = createAddClip({ ...deps, fetchClips })
  const startTranscription = createStartTranscription(deps)
  const stopTranscription = createStopTranscription(deps)
  const syncNow = createSyncNow(deps)
  const autoSync = createAutoSync(deps)
  const fetchSyncState = createFetchSyncState(deps)
  const fetchDownloaderState = createFetchDownloaderState(deps)
  const updateDownloader = createUpdateDownloader(deps)
  const updateSettings = createUpdateSettings(deps)
  const fetchSessions = createFetchSessions(deps)
  const trackSession = createTrackSession(deps)
  const finalizeSession = createFinalizeSession(deps)

  // Dev
  const __DEV_resetApp = createResetApp({ db, audio, set })

  // Event listeners -------------------------------------------------------------------------------

  audio.on('status', onAudioStatus)
  sync.on('status', onSyncStatus)
  sync.on('data', onSyncData)
  transcription.on('queued', onTranscriptionQueued)
  transcription.on('finish', onTranscriptionFinish)
  transcription.on('status', onTranscriptionStatus)

  // Auto-load last played book -------------------------------------------------------------------

  const lastPlayed = db.getLastPlayedBook()
  if (lastPlayed?.uri) {
    loadBook({
      fileUri: lastPlayed.uri,
      position: lastPlayed.position,
      ownerId: MAIN_PLAYER_OWNER_ID,
    }).catch(() => {}) // non-critical
  }

  // Initial state ---------------------------------------------------------------------------------

  return {
    // State:
    clips: {},
    books: {},
    settings: db.getSettings(),
    sessions: {},

    library: {
      status: 'loading',
      addProgress: null,
      addOpId: null,
      message: null,
    },

    playback: {
      status: 'idle',
      ownerId: null,
      uri: null,
      position: 0,
      duration: 0,
    },

    transcription: {
      status: 'idle',
      pending: {},
    },

    sync: {
      isSyncing: false,
      pendingCount: sync.getPendingCount(),
      lastSyncTime: db.getLastSyncTime(),
      error: null,
    },

    downloader: {
      version: null,
      status: 'idle',
    },

    currentSessionBookId: null, // TODO sucks

    // Actions:
    fetchBooks,
    loadFile,
    loadFileWithUri,
    loadFileWithPicker,
    loadFromUrl,
    cancelLoadFile,
    archiveBook,
    deleteBook,
    updateBook,
    play,
    pause,
    seek,
    seekClip,
    skipForward,
    skipBackward,
    fetchPlaybackState,
    fetchClips,
    addClip,
    updateClip,
    deleteClip,
    shareClip,
    startTranscription,
    stopTranscription,
    syncNow,
    autoSync,
    fetchSyncState,
    fetchDownloaderState,
    updateDownloader,
    updateSettings,
    fetchSessions,
    trackSession,
    __DEV_resetApp,
  }

  // Event handler functions (hoisted) -------------------------------------------------------------

  function onAudioStatus(status: PlaybackStatus) {
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
  }

  function onSyncStatus(status: SyncStatus) {
    set((state) => {
      state.sync = {
        ...status,
        lastSyncTime: status.isSyncing ? state.sync.lastSyncTime : db.getLastSyncTime(),
      }
    })
  }

  function onSyncData(notification: SyncNotification) {
    if (notification.booksChanged.length > 0) {
      fetchBooks()
    }
    if (notification.clipsChanged.length > 0) {
      fetchClips()
    }
  }

  function onTranscriptionQueued({ clipId }: TranscriptionQueueEvents['queued']) {
    set(state => {
      state.transcription.pending[clipId] = true
    })
  }

  function onTranscriptionFinish({ clipId, error, transcription }: TranscriptionQueueEvents['finish']) {
    // error is logged by TranscriptionQueueService at the source

    set(state => {
      delete state.transcription.pending[clipId]
    })

    if (transcription) {
      updateClip(clipId, { transcription })
    }
  }

  function onTranscriptionStatus({ status }: TranscriptionQueueEvents['status']) {
    set(state => {
      state.transcription.status = status
    })
  }
}))

// Re-export types for consumers
export type { AppState } from './types'
