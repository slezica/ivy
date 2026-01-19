import { create } from 'zustand'
import RNFS from 'react-native-fs'

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

import type { PickedFile, Book, Settings } from '../services'
import { MAIN_PLAYER_OWNER_ID, generateId } from '../utils'
import { createClipSlice } from './clips'
import type { AppState, PlaybackContext } from './types'

const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000
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
          fetchBooks()
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
        audio: {
          ...state.audio,
          // Only update status if not currently in a transitional state
          status: state.audio.status === 'loading'
            ? state.audio.status
            : status.status,
          position: status.position,
        },
      }))

      // Update book position in database
      // Only if we have a file loaded and valid position
      const { audio, books } = get()
      if (audio.uri && status.position >= 0 && status.duration > 0) {
        const book = Object.values(books).find(b => b.uri === audio.uri)
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

  const clipSlice = createClipSlice({
    db: dbService,
    slicer: slicerService,
    queue: queueService,
    transcription: transcriptionService,
    sharing: sharingService,
  })(set, get)

  return {
    // Initial state
    library: {
      status: 'loading',
    },
    audio: {
      status: 'idle',
      position: 0,
      uri: null,
      duration: 0,
      ownerId: null,
    },
    sync: {
      isSyncing: false,
      pendingCount: syncService.getPendingCount(),
      lastSyncTime: dbService.getLastSyncTime(),
      error: null,
    },
    books: {},
    settings: dbService.getSettings(),

    // Slices
    ...clipSlice,

    // Actions (below)
    loadFileWithPicker,
    loadFile,
    loadFileWithUri,
    fetchBooks,
    archiveBook,
    play,
    pause,
    seek,
    skipForward,
    skipBackward,
    syncPlaybackState,
    updateSettings,
    syncNow,
    autoSync,
    refreshSyncStatus,
    __DEV_resetApp
  }

  function fetchBooks(): void {
    const allBooks = dbService.getAllBooks()

    // Update books mapping in store (keyed by id)
    const booksMap = allBooks.reduce((acc, book) => {
      acc[book.id] = book
      return acc
    }, {} as Record<string, Book>)

    set({ books: booksMap, library: { status: 'idle' } })
  }

  async function archiveBook(bookId: string): Promise<void> {
    const { books } = get()
    const book = books[bookId]

    if (!book) {
      throw new Error('Book not found')
    }

    const previousUri = book.uri

    // 1. Optimistic store update
    set((state) => ({
      books: {
        ...state.books,
        [bookId]: { ...state.books[bookId], uri: null },
      },
    }))

    // 2. Database update (with rollback on fail)
    try {
      dbService.archiveBook(bookId)
      queueService.queueChange('book', bookId, 'upsert')
    } catch (error) {
      // Rollback store
      set((state) => ({
        books: {
          ...state.books,
          [bookId]: { ...state.books[bookId], uri: previousUri },
        },
      }))
      throw error
    }

    // 3. Async file deletion (fire and forget - file is orphaned if this fails)
    if (previousUri) {
      fileStorageService.deleteFile(previousUri).catch((error) => {
        console.error('Failed to delete archived book file (non-critical):', error)
      })
    }
  }

  async function loadFileWithUri(uri: string, name: string) {
    await get().loadFile({ uri, name })
  }

  async function loadFileWithPicker() {
    const pickedFile = await filePickerService.pickAudioFile()
    if (pickedFile) {
      await get().loadFile(pickedFile)
    }
  }

  async function loadFile(pickedFile: PickedFile) {
    try {
      // Step 1: Copy file to app storage
      console.log('Copying file to app storage from:', pickedFile.uri)
      set({ library: { status: 'adding' } })

      const localUri = await fileStorageService.copyToAppStorage(pickedFile.uri, pickedFile.name)
      console.log('File copied to:', localUri)

      // Step 2: Read metadata
      console.log('Reading metadata from:', localUri)
      const metadata = await metadataService.readMetadata(localUri)
      console.log('Metadata read:', metadata)

      // Step 3: Read file fingerprint
      const { fileSize, fingerprint } = await fileStorageService.readFileFingerprint(localUri)
      console.log('File fingerprint:', fileSize, 'bytes,', fingerprint.length, 'byte sample')

      // Step 4: Check for existing book with same fingerprint
      const existingBook = dbService.getBookByFingerprint(fileSize, fingerprint)

      // Verify file exists before loading
      const exists = await fileStorageService.fileExists(localUri)
      console.log('Local file exists check:', exists, localUri)
      if (!exists) {
        throw new Error(`Local file does not exist: ${localUri}`)
      }

      // Step 5: Load audio from local URI
      set((state) => ({
        library: { status: 'idle' },
        audio: { ...state.audio, status: 'loading' },
      }))

      console.log('Loading audio from:', localUri)
      const duration = await audioService.load(localUri, {
        title: metadata.title,
        artist: metadata.artist,
        artwork: metadata.artwork,
      })
      console.log('Audio loaded successfully, duration:', duration)

      // Step 6: Determine which book record to use
      let book: Book

      if (existingBook) {
        if (existingBook.uri === null) {
          // Case A: Archived book - restore it with new file
          console.log('Restoring archived book:', existingBook.id)
          book = dbService.restoreBook(
            existingBook.id,
            localUri,
            pickedFile.name,
            duration,
            metadata.title,
            metadata.artist,
            metadata.artwork
          )
          queueService.queueChange('book', book.id, 'upsert')
        } else {
          // Case B: Active book - delete duplicate file, use existing
          console.log('File already exists in library, removing duplicate:', localUri)
          await fileStorageService.deleteFile(localUri)
          dbService.touchBook(existingBook.id)
          book = dbService.getBookById(existingBook.id)!
          queueService.queueChange('book', book.id, 'upsert')

          // Reload audio from existing file
          await audioService.load(book.uri!, {
            title: book.title,
            artist: book.artist,
            artwork: book.artwork,
          })
        }
      } else {
        // Case C: New book - create record
        console.log('Creating new book record')
        book = dbService.upsertBook(
          localUri,
          pickedFile.name,
          duration,
          0,
          metadata.title,
          metadata.artist,
          metadata.artwork,
          fileSize,
          fingerprint
        )
        queueService.queueChange('book', book.id, 'upsert')
      }

      // Refresh books and clips in store
      fetchBooks()
      get().fetchClips()

      // Update state (keep status as 'loading' until play starts)
      set((state) => ({
        audio: {
          ...state.audio,
          position: book.position,
          uri: book.uri!,
          duration: duration,
        },
      }))

      // Seek to saved position
      if (book.position > 0) {
        await audioService.seek(book.position)
      }

      // Auto-play after loading (this will set status to 'playing')
      // Target the main player so it adopts the book
      await get().play({
        fileUri: book.uri!,
        position: book.position,
        ownerId: MAIN_PLAYER_OWNER_ID,
      })
    } catch (error) {
      console.error(error)
      // Reset loading state on error
      set((state) => ({
        library: { status: 'idle' },
        audio: { ...state.audio, status: state.audio.uri ? 'paused' : 'idle' },
      }))
      throw error
    }
  }

  async function play(context?: PlaybackContext) {
    try {
      // If context provided, may need to load file and seek first
      if (context) {
        const { audio } = get()
        const isFileSame = audio.uri === context.fileUri

        if (!isFileSame) {
          // Need to load a different file (could be book or clip audio)
          const bookRecord = dbService.getBookByAnyUri(context.fileUri)
          if (!bookRecord) {
            throw new Error(`No book or clip found for: ${context.fileUri}`)
          }

          set((state) => ({
            audio: {
              ...state.audio,
              status: 'loading',
              ...(context.ownerId !== undefined && { ownerId: context.ownerId }),
            },
          }))

          const duration = await audioService.load(context.fileUri, {
            title: bookRecord.title,
            artist: bookRecord.artist,
            artwork: bookRecord.artwork,
          })

          set((state) => ({
            audio: {
              ...state.audio,
              uri: context.fileUri,
              duration: duration,
              position: context.position,
            },
          }))

          await audioService.seek(context.position)
        } else if (audio.position !== context.position) {
          // Same file, different position - just seek
          await audioService.seek(context.position)
          set((state) => ({
            audio: { ...state.audio, position: context.position },
          }))
        }

        // Set status to playing, and owner if provided
        set((state) => ({
          audio: {
            ...state.audio,
            status: 'playing',
            ...(context.ownerId !== undefined && { ownerId: context.ownerId }),
          },
        }))
      } else {
        // No context - just resume, keep existing owner
        set((state) => ({
          audio: { ...state.audio, status: 'playing' },
        }))
      }

      await audioService.play()
    } catch (error) {
      console.error('Error playing audio:', error)
      set((state) => ({
        audio: { ...state.audio, status: state.audio.uri ? 'paused' : 'idle' },
      }))
      throw error
    }
  }

  async function pause() {
    set((state) => ({
      audio: { ...state.audio, status: 'paused' },
    }))

    try {
      await audioService.pause()
    } catch (error) {
      console.error('Error pausing audio:', error)
      throw error
    }
  }

  async function seek(context: PlaybackContext) {
    const { audio } = get()

    // Only seek if the requested file is currently loaded
    if (audio.uri !== context.fileUri) {
      console.log('Seek ignored: file not loaded', context.fileUri)
      return
    }

    set((state) => ({
      audio: { ...state.audio, position: context.position },
    }))

    try {
      await audioService.seek(context.position)
    } catch (error) {
      console.error('Error seeking:', error)
      throw error
    }
  }

  async function skipForward() {
    try {
      await audioService.skip(SKIP_FORWARD_MS)
    } catch (error) {
      console.error('Error skipping forward:', error)
      throw error
    }
  }

  async function skipBackward() {
    try {
      await audioService.skip(-SKIP_BACKWARD_MS)
    } catch (error) {
      console.error('Error skipping backward:', error)
      throw error
    }
  }

  async function syncPlaybackState() {
    const status = await audioService.getStatus()
    if (!status) return

    set((state) => ({
      audio: {
        ...state.audio,
        status: state.audio.status === 'loading'
          ? state.audio.status
          : status.status,
        position: status.position,
      },
    }))
  }

  function updateSettings(settings: Settings) {
    dbService.setSettings(settings)
    set({ settings })
  }

  function refreshSyncStatus() {
    set((state) => ({
      sync: {
        ...state.sync,
        pendingCount: syncService.getPendingCount(),
        lastSyncTime: dbService.getLastSyncTime(),
      },
    }))
  }

  function syncNow(): void {
    syncService.syncNow()
  }

  async function autoSync(): Promise<void> {
    const { settings } = get()
    if (!settings.sync_enabled) return
    await syncService.autoSync()
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
      audio: {
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
