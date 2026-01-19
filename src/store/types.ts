/**
 * Store Types
 *
 * Central type definitions for the entire store.
 * Read top-down to understand the full store shape.
 */

import type { ClipWithFile, Book, Settings } from '../services'

// =============================================================================
// AppState - The Complete Store
// =============================================================================

export interface AppState extends ClipSlice {
  // State
  library: LibraryState
  audio: AudioState
  sync: SyncState
  books: Record<string, Book>
  settings: Settings

  // Library actions
  loadFile: (pickedFile: { uri: string; name: string }) => Promise<void>
  loadFileWithUri: (uri: string, name: string) => Promise<void>
  loadFileWithPicker: () => Promise<void>
  fetchBooks: () => void
  archiveBook: (bookId: string) => Promise<void>

  // Playback actions
  play: (context?: PlaybackContext) => Promise<void>
  pause: () => Promise<void>
  seek: (context: PlaybackContext) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  syncPlaybackState: () => Promise<void>

  // Settings actions
  updateSettings: (settings: Settings) => void

  // Sync actions
  syncNow: () => void
  autoSync: () => Promise<void>
  refreshSyncStatus: () => void

  // Dev tools
  __DEV_resetApp: () => Promise<void>
}

// =============================================================================
// Slices
// =============================================================================

export interface ClipSlice {
  clips: Record<string, ClipWithFile>
  fetchClips: () => void
  addClip: (bookId: string, position: number) => Promise<void>
  updateClip: (id: string, updates: { note?: string; start?: number; duration?: number }) => Promise<void>
  updateClipTranscription: (id: string, transcription: string) => void
  deleteClip: (id: string) => Promise<void>
  jumpToClip: (clipId: string) => Promise<void>
  shareClip: (clipId: string) => Promise<void>
}

// =============================================================================
// State Types
// =============================================================================

export interface LibraryState {
  status: LibraryStatus
}

export type LibraryStatus = 'loading' | 'idle' | 'adding'

export interface AudioState {
  status: AudioStatus
  position: number
  uri: string | null       // URI currently loaded in player
  duration: number         // Duration of loaded audio
  ownerId: string | null   // ID of component that last took control
}

export type AudioStatus = 'idle' | 'loading' | 'paused' | 'playing'

export interface SyncState {
  isSyncing: boolean
  pendingCount: number
  lastSyncTime: number | null
  error: string | null
}

/**
 * Context for playback actions. Components must specify which file
 * and position they want to play/seek.
 */
export interface PlaybackContext {
  fileUri: string
  position: number
  ownerId?: string
}

// =============================================================================
// Zustand Helpers
// =============================================================================

export type SetState = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void

export type GetState = () => AppState
