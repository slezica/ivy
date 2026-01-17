import { create } from 'zustand'
import RNFS from 'react-native-fs'

import {
  AudioPlayerService,
  FilePickerService,
  FileStorageService,
  AudioMetadataService,
  SharingService,
  transcriptionService,
  databaseService,
  audioSlicerService,
} from '../services'

import type { PickedFile, ClipWithFile, Book } from '../services'
import { MAIN_PLAYER_OWNER_ID } from '../utils'

const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`


const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000
const DEFAULT_CLIP_DURATION_MS = 20 * 1000


type AudioStatus = 'idle' | 'loading' | 'paused' | 'playing'

interface AudioState {
  status: AudioStatus
  position: number
  uri: string | null       // URI currently loaded in player (hardware state)
  duration: number         // Duration of loaded audio (hardware state)
  ownerId: string | null   // ID of component that last took control
}

type LibraryStatus = 'loading' | 'idle' | 'adding'

interface LibraryState {
  status: LibraryStatus
}

/**
 * Context for playback actions. Components must specify which file
 * and position they want to play/seek. This prevents "accidents" where
 * a component unknowingly affects another component's playback.
 */
interface PlaybackContext {
  fileUri: string
  position: number
  ownerId?: string  // ID of component taking control (optional)
}

interface AppState {
  // State
  library: LibraryState
  audio: AudioState
  clips: Record<number, ClipWithFile>
  books: Record<number, Book>

  // Actions
  loadFile: (pickedFile: PickedFile) => Promise<void>
  loadFileWithUri: (uri: string, name: string) => Promise<void>
  loadFileWithPicker: () => Promise<void>
  fetchBooks: () => void
  archiveBook: (bookId: number) => Promise<void>
  fetchAllClips: () => void
  play: (context?: PlaybackContext) => Promise<void>
  pause: () => Promise<void>
  seek: (context: PlaybackContext) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  addClip: (bookId: number, position: number) => Promise<void>
  updateClip: (id: number, updates: { note?: string; start?: number; duration?: number }) => Promise<void>
  updateClipTranscription: (id: number, transcription: string) => void
  deleteClip: (id: number) => Promise<void>
  jumpToClip: (clipId: number) => Promise<void>
  shareClip: (clipId: number) => Promise<void>
  syncPlaybackState: () => Promise<void>

  // Dev tools
  __DEV_resetApp: () => Promise<void>
}


export const useStore = create<AppState>((set, get) => {
  // ---------------------------------------------------------------------------
  // Initialize services
  // ---------------------------------------------------------------------------

  // Use shared singletons for services that need to be accessed from multiple places
  const dbService = databaseService
  const slicerService = audioSlicerService

  // Create local instances for services only used by the store
  const filePickerService = new FilePickerService()
  const fileStorageService = new FileStorageService()
  const metadataService = new AudioMetadataService()

  const sharingService = new SharingService()

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
        }
      }
    },
  })

  // Set up transcription callback to update store when transcription completes
  transcriptionService.setCallback((clipId, transcription) => {
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
  })

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
    clips: {},
    books: {},

    // Actions (below)
    loadFileWithPicker,
    loadFile,
    loadFileWithUri,
    fetchBooks,
    archiveBook,
    fetchAllClips,
    play,
    pause,
    seek,
    skipForward,
    skipBackward,
    addClip,
    deleteClip,
    updateClip,
    updateClipTranscription,
    jumpToClip,
    shareClip,
    syncPlaybackState,
    __DEV_resetApp
  }

  function fetchBooks(): void {
    const allBooks = dbService.getAllBooks()

    // Update books mapping in store (keyed by id)
    const booksMap = allBooks.reduce((acc, book) => {
      acc[book.id] = book
      return acc
    }, {} as Record<number, Book>)

    set({ books: booksMap, library: { status: 'idle' } })
  }

  async function archiveBook(bookId: number): Promise<void> {
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

  function fetchAllClips(): void {
    const allClips = dbService.getAllClips()

    // Update clips mapping in store
    const clipsMap = allClips.reduce((acc, clip) => {
      acc[clip.id] = clip
      return acc
    }, {} as Record<number, ClipWithFile>)

    set({ clips: clipsMap })
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
      // Step 1: Copy file to app storage if needed
      let localUri: string
      let book = dbService.getBookByUri(pickedFile.uri)
      let isNewBook = false

      if (book?.uri && await fileStorageService.fileExists(book.uri)) {
        // Already have a local copy - use it
        localUri = book.uri
        console.log('Using existing local file:', localUri)
      } else {
        // Need to copy file to app storage
        console.log('Copying file to app storage from:', pickedFile.uri)
        set({ library: { status: 'adding' } })

        localUri = await fileStorageService.copyToAppStorage(pickedFile.uri, pickedFile.name)
        console.log('File copied to:', localUri)
        isNewBook = true
      }

      // Step 2: Read metadata (only for new books, during 'adding' phase)
      let metadata: { title: string | null; artist: string | null; artwork: string | null } = {
        title: null,
        artist: null,
        artwork: null,
      }
      if (isNewBook) {
        console.log('Reading metadata from:', localUri)
        metadata = await metadataService.readMetadata(localUri)
        console.log('Metadata read:', metadata)
      }

      // Verify file exists before loading
      const exists = await fileStorageService.fileExists(localUri)
      console.log('Local file exists check:', exists, localUri)
      if (!exists) {
        throw new Error(`Local file does not exist: ${localUri}`)
      }

      // Step 3: Load audio from local URI
      set((state) => ({
        library: { status: 'idle' },
        audio: { ...state.audio, status: 'loading' },
      }))

      console.log('Loading audio from:', localUri)
      const duration = await audioService.load(localUri, {
        title: isNewBook ? metadata.title : book?.title,
        artist: isNewBook ? metadata.artist : book?.artist,
        artwork: isNewBook ? metadata.artwork : book?.artwork,
      })
      console.log('Audio loaded successfully, duration:', duration)

      // Step 4: Save/update book record in database
      // Save local URI as 'uri' (what we actually use) and original as 'original_uri'
      book = dbService.upsertBook(
        localUri,
        pickedFile.name,
        duration,
        book?.position ?? 0,
        pickedFile.uri,
        isNewBook ? metadata.title : book?.title ?? null,
        isNewBook ? metadata.artist : book?.artist ?? null,
        isNewBook ? metadata.artwork : book?.artwork ?? null
      )

      // Load all clips
      fetchAllClips()

      // Update state (keep status as 'loading' until play starts)
      set((state) => ({
        audio: {
          ...state.audio,
          position: book.position,
          uri: localUri,
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
        fileUri: book.uri!, // We just set this to localUri above
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
          // Need to load a different file
          const bookRecord = dbService.getBookByUri(context.fileUri)
          if (!bookRecord) {
            throw new Error(`Book not found in library: ${context.fileUri}`)
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

  async function addClip(bookId: number, position: number) {
    const { books } = get()
    const book = books[bookId]

    if (!book) {
      throw new Error('Book not found')
    }
    if (!book.uri) {
      throw new Error('Book has been archived')
    }

    // Cap clip duration to not exceed remaining audio length
    const remainingDuration = book.duration - position
    const clipDuration = Math.min(DEFAULT_CLIP_DURATION_MS, remainingDuration)

    // Generate random filename and slice audio
    const filename = `${generateRandomString()}.mp3`
    await slicerService.ensureDir(CLIPS_DIR)
    const sliceResult = await slicerService.slice({
      sourceUri: book.uri,
      startMs: position,
      endMs: position + clipDuration,
      outputFilename: filename,
      outputDir: CLIPS_DIR,
    })

    const clip = dbService.createClip(
      bookId,
      sliceResult.uri,
      position,
      clipDuration,
      '' // Default empty note
    )

    // Reload all clips to include file information
    fetchAllClips()

    // Queue for transcription
    transcriptionService.queueClip(clip.id)
  }

  async function updateClip(id: number, updates: { note?: string; start?: number; duration?: number }) {
    const { clips } = get()
    const clip = clips[id]
    if (!clip) return

    const boundsChanged =
      (updates.start !== undefined && updates.start !== clip.start) ||
      (updates.duration !== undefined && updates.duration !== clip.duration)

    let newUri: string | undefined

    // Re-slice if bounds changed (only possible if source file exists)
    if (boundsChanged) {
      if (!clip.file_uri) {
        throw new Error('Cannot edit clip bounds: source file has been removed')
      }

      const newStart = updates.start ?? clip.start
      const newDuration = updates.duration ?? clip.duration

      // Generate new slice
      const filename = `${generateRandomString()}.mp3`
      await slicerService.ensureDir(CLIPS_DIR)
      const sliceResult = await slicerService.slice({
        sourceUri: clip.file_uri,
        startMs: newStart,
        endMs: newStart + newDuration,
        outputFilename: filename,
        outputDir: CLIPS_DIR,
      })

      newUri = sliceResult.uri

      // Delete old clip file
      await slicerService.cleanup(clip.uri)
    }

    // Update database
    dbService.updateClip(id, { ...updates, uri: newUri })

    // Update store
    set((state) => ({
      clips: {
        ...state.clips,
        [id]: {
          ...state.clips[id],
          ...updates,
          ...(newUri && { uri: newUri }),
          updated_at: Date.now(),
        },
      },
    }))
  }

  function updateClipTranscription(id: number, transcription: string) {
    set((state) => {
      const clip = state.clips[id]
      if (!clip) return state

      return {
        clips: {
          ...state.clips,
          [id]: {
            ...clip,
            transcription,
            updated_at: Date.now(),
          },
        },
      }
    })
  }

  async function deleteClip(id: number) {
    const { clips } = get()
    const clip = clips[id]

    // Delete clip audio file
    if (clip?.uri) {
      await slicerService.cleanup(clip.uri)
    }

    dbService.deleteClip(id)

    set((state) => {
      const { [id]: removed, ...rest } = state.clips
      return { clips: rest }
    })
  }

  async function jumpToClip(clipId: number) {
    const clip = get().clips[clipId]
    if (!clip) {
      throw new Error('Clip not found')
    }
    if (!clip.file_uri) {
      throw new Error('Cannot jump to clip: source file has been removed')
    }

    // Jump to clip includes loading the file if different
    await get().play({ fileUri: clip.file_uri, position: clip.start })
  }

  async function shareClip(clipId: number) {
    const { clips } = get()
    const clip = clips[clipId]

    if (!clip) {
      throw new Error('Clip not found')
    }

    // Share using the clip's existing audio file
    await sharingService.shareClipFile(clip.uri, clip.note || clip.file_name)
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
      clips: {},
      books: {},
    })

    console.log('App reset complete')
  }
})

function generateRandomString(): string {
  return (Math.random() + 1).toString(36).substring(2)
}
