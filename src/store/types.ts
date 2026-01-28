import type { ClipWithFile, Book, Settings, SessionWithBook } from '../services'

// Action types
import type { FetchBooks } from '../actions/fetch_books'
import type { FetchClips } from '../actions/fetch_clips'
import type { LoadFile } from '../actions/load_file'
import type { LoadFileWithUri } from '../actions/load_file_with_uri'
import type { LoadFileWithPicker } from '../actions/load_file_with_picker'
import type { ArchiveBook } from '../actions/archive_book'
import type { DeleteBook } from '../actions/delete_book'
import type { Play } from '../actions/play'
import type { Pause } from '../actions/pause'
import type { Seek } from '../actions/seek'
import type { SeekClip } from '../actions/seek_clip'
import type { SkipForward } from '../actions/skip_forward'
import type { SkipBackward } from '../actions/skip_backward'
import type { SyncPlaybackState } from '../actions/sync_playback_state'
import type { AddClip } from '../actions/add_clip'
import type { UpdateClip } from '../actions/update_clip'
import type { DeleteClip } from '../actions/delete_clip'
import type { ShareClip } from '../actions/share_clip'
import type { StartTranscription } from '../actions/start_transcription'
import type { StopTranscription } from '../actions/stop_transcription'
import type { SyncNow } from '../actions/sync_now'
import type { AutoSync } from '../actions/auto_sync'
import type { RefreshSyncStatus } from '../actions/refresh_sync_status'
import type { UpdateSettings } from '../actions/update_settings'
import type { FetchSessions } from '../actions/fetch_sessions'
import type { TrackSession } from '../actions/track_session'
import type { ResetApp } from '../actions/reset_app'


export interface AppState {
  // State
  library: { status: 'loading' | 'idle' | 'adding' }
  books: Record<string, Book>
  playback: {
    status: 'idle' | 'loading' | 'paused' | 'playing'
    position: number
    uri: string | null       // URI currently loaded in player
    duration: number         // Duration of loaded audio
    ownerId: string | null   // ID of component that last took control
  }
  clips: Record<string, ClipWithFile>
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
  settings: Settings
  sessions: SessionWithBook[]
  currentSessionBookId: string | null

  // Actions
  fetchBooks: FetchBooks
  loadFile: LoadFile
  loadFileWithUri: LoadFileWithUri
  loadFileWithPicker: LoadFileWithPicker
  archiveBook: ArchiveBook
  deleteBook: DeleteBook
  play: Play
  pause: Pause
  seek: Seek
  seekClip: SeekClip
  skipForward: SkipForward
  skipBackward: SkipBackward
  syncPlaybackState: SyncPlaybackState
  fetchClips: FetchClips
  addClip: AddClip
  updateClip: UpdateClip
  deleteClip: DeleteClip
  shareClip: ShareClip
  startTranscription: StartTranscription
  stopTranscription: StopTranscription
  syncNow: SyncNow
  autoSync: AutoSync
  refreshSyncStatus: RefreshSyncStatus
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
