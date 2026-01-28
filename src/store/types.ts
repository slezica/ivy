import type { ClipWithFile, Book, Settings, SessionWithBook } from '../services'


export interface AppState extends
  LibrarySlice,
  PlaybackSlice,
  ClipSlice,
  TranscriptionSlice,
  SyncSlice,
  SettingsSlice,
  SessionSlice,
  DevSlice {

  // Each slice adds data and actions. All slices have access to the full state.
}


export interface LibrarySlice {
  library: {
    status: 'loading' | 'idle' | 'adding'
  }
  books: Record<string, Book>

  fetchBooks: () => Promise<void>
  loadFile: (pickedFile: { uri: string; name: string }) => Promise<void>
  loadFileWithUri: (uri: string, name: string) => Promise<void>
  loadFileWithPicker: () => Promise<void>
  archiveBook: (bookId: string) => Promise<void>
  deleteBook: (bookId: string) => Promise<void>
}


export interface PlaybackSlice {
  playback: {
    status: 'idle' | 'loading' | 'paused' | 'playing'
    position: number
    uri: string | null       // URI currently loaded in player
    duration: number         // Duration of loaded audio
    ownerId: string | null   // ID of component that last took control
  }

  play: (context?: PlaybackContext) => Promise<void>
  pause: () => Promise<void>
  seek: (context: PlaybackContext) => Promise<void>
  seekClip: (clipId: string) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  syncPlaybackState: () => Promise<void>
}


export interface ClipSlice {
  clips: Record<string, ClipWithFile>

  fetchClips: () => Promise<void>
  addClip: (bookId: string, position: number) => Promise<void>
  updateClip: (id: string, updates: { note?: string; start?: number; duration?: number; transcription?: string | null }) => Promise<void>
  deleteClip: (id: string) => Promise<void>
  shareClip: (clipId: string) => Promise<void>
}


export interface TranscriptionSlice {
  transcription: {
    status: 'idle' | 'downloading' | 'processing'
    pending: Record<string, true>
  }

  startTranscription: () => Promise<void>
  stopTranscription: () => Promise<void>
}


export interface SyncSlice {
  sync: {
    isSyncing: boolean
    pendingCount: number
    lastSyncTime: number | null
    error: string | null
  }

  syncNow: () => void
  autoSync: () => Promise<void>
  refreshSyncStatus: () => void
}


export interface SettingsSlice {
  settings: Settings
  updateSettings: (settings: Settings) => Promise<void>
}


export interface SessionSlice {
  sessions: SessionWithBook[]
  currentSessionBookId: string | null
  fetchSessions: () => Promise<void>
  trackSession: (bookId: string) => Promise<void>
}


export interface DevSlice {
  __DEV_resetApp: () => Promise<void>
}


/**
 * Context for playback actions. Components must specify file and position they want to play/seek.
 */
export interface PlaybackContext {
  fileUri: string
  position: number
  ownerId?: string
}


export type GetState = () => AppState
export type SetState = (partial: Partial<AppState> | ((state: AppState) => void)) => void

// Actions are async functions that take arguments and return Promise<void>:
export type Action<Args extends unknown[]> = (...args: Args) => Promise<void>

// Action factories create Actions with dependencies:
export type ActionFactory<Deps, A extends Action<any>> = (deps: Deps) => A

