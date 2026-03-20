import type { ClipWithFile, Book, Settings, SessionWithBook } from '../services'

// Action types
import type { FetchBooks } from '../actions/fetch_books'
import type { FetchClips } from '../actions/fetch_clips'
import type { LoadFile } from '../actions/load_file'
import type { LoadFileWithUri } from '../actions/load_file_with_uri'
import type { LoadFileWithPicker } from '../actions/load_file_with_picker'
import type { LoadFromUrl } from '../actions/load_from_url'
import type { CancelLoadFile } from '../actions/cancel_load_file'
import type { ArchiveBook } from '../actions/archive_book'
import type { DeleteBook } from '../actions/delete_book'
import type { Play } from '../actions/play'
import type { Pause } from '../actions/pause'
import type { Seek } from '../actions/seek'
import type { SeekClip } from '../actions/seek_clip'
import type { SkipForward } from '../actions/skip_forward'
import type { SkipBackward } from '../actions/skip_backward'
import type { FetchPlaybackState } from '../actions/fetch_playback_state'
import type { AddClip } from '../actions/add_clip'
import type { UpdateClip } from '../actions/update_clip'
import type { DeleteClip } from '../actions/delete_clip'
import type { ShareClip } from '../actions/share_clip'
import type { StartTranscription } from '../actions/start_transcription'
import type { StopTranscription } from '../actions/stop_transcription'
import type { SyncNow } from '../actions/sync_now'
import type { AutoSync } from '../actions/auto_sync'
import type { FetchSyncState } from '../actions/fetch_sync_state'
import type { UpdateSettings } from '../actions/update_settings'
import type { FetchSessions } from '../actions/fetch_sessions'
import type { TrackSession } from '../actions/track_session'
import type { UpdateBook } from '../actions/update_book'
import type { FetchDownloaderState } from '../actions/fetch_downloader_state'
import type { UpdateDownloader } from '../actions/update_downloader'
import type { ResetApp } from '../actions/reset_app'


export interface AppState {
  // State
  books: Record<string, Book>
  clips: Record<string, ClipWithFile>
  settings: Settings
  sessions: Record<string, SessionWithBook>

  library: {
    status: 'loading' | 'idle' | 'adding' | 'duplicate' | 'error'
    addProgress: number | null  // 0-100 percent
    addOpId: string | null
  }

  playback: {
    status: 'idle' | 'loading' | 'paused' | 'playing'
    position: number
    uri: string | null       // URI currently loaded in player
    duration: number         // Duration of loaded audio
    ownerId: string | null   // ID of component that last took control
  }

  transcription: {
    status: 'idle' | 'downloading' | 'processing'
    pending: Record<string, true>
  }

  sync: {
    isSyncing: boolean
    pendingCount: number
    lastSyncTime: number | null
    error: string | null
  }

  downloader: {
    version: string | null
    status: 'idle' | 'downloading' | 'updating'
  }

  currentSessionBookId: string | null // TODO move out of here

  // Actions
  fetchBooks: FetchBooks
  loadFile: LoadFile
  loadFileWithUri: LoadFileWithUri
  loadFileWithPicker: LoadFileWithPicker
  loadFromUrl: LoadFromUrl
  cancelLoadFile: CancelLoadFile
  archiveBook: ArchiveBook
  deleteBook: DeleteBook
  updateBook: UpdateBook
  play: Play
  pause: Pause
  seek: Seek
  seekClip: SeekClip
  skipForward: SkipForward
  skipBackward: SkipBackward
  fetchPlaybackState: FetchPlaybackState
  fetchClips: FetchClips
  addClip: AddClip
  updateClip: UpdateClip
  deleteClip: DeleteClip
  shareClip: ShareClip
  startTranscription: StartTranscription
  stopTranscription: StopTranscription
  syncNow: SyncNow
  autoSync: AutoSync
  fetchSyncState: FetchSyncState
  fetchDownloaderState: FetchDownloaderState
  updateDownloader: UpdateDownloader
  updateSettings: UpdateSettings
  fetchSessions: FetchSessions
  trackSession: TrackSession
  __DEV_resetApp: ResetApp
}


export type GetState = () => AppState
export type SetState = (partial: Partial<AppState> | ((state: AppState) => void)) => void

// Actions are async functions that take arguments and return Promise<void>:
export type Action<Args extends unknown[]> = (...args: Args) => Promise<void>

// Action factories create Actions with dependencies:
export type ActionFactory<Deps, A extends Action<any>> = (deps: Deps) => A
