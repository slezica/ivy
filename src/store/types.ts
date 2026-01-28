import type { ClipWithFile, Book, Settings, SessionWithBook } from '../services'


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
  fetchBooks: () => Promise<void>
  loadFile: (pickedFile: { uri: string; name: string }) => Promise<void>
  loadFileWithUri: (uri: string, name: string) => Promise<void>
  loadFileWithPicker: () => Promise<void>
  archiveBook: (bookId: string) => Promise<void>
  deleteBook: (bookId: string) => Promise<void>
  play: (context?: { fileUri: string; position: number; ownerId?: string }) => Promise<void>
  pause: () => Promise<void>
  seek: (context: { fileUri: string; position: number }) => Promise<void>
  seekClip: (clipId: string) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  syncPlaybackState: () => Promise<void>
  fetchClips: () => Promise<void>
  addClip: (bookId: string, position: number) => Promise<void>
  updateClip: (id: string, updates: { note?: string; start?: number; duration?: number; transcription?: string | null }) => Promise<void>
  deleteClip: (id: string) => Promise<void>
  shareClip: (clipId: string) => Promise<void>
  startTranscription: () => Promise<void>
  stopTranscription: () => Promise<void>
  syncNow: () => Promise<void>
  autoSync: () => Promise<void>
  refreshSyncStatus: () => Promise<void>
  updateSettings: (settings: Settings) => Promise<void>
  fetchSessions: () => Promise<void>
  trackSession: (bookId: string) => Promise<void>
  __DEV_resetApp: () => Promise<void>
}


export type GetState = () => AppState
export type SetState = (partial: Partial<AppState> | ((state: AppState) => void)) => void

// Actions are async functions that take arguments and return Promise<void>:
export type Action<Args extends unknown[]> = (...args: Args) => Promise<void>

// Action factories create Actions with dependencies:
export type ActionFactory<Deps, A extends Action<any>> = (deps: Deps) => A

