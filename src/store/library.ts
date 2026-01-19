import type {
  DatabaseService,
  FileStorageService,
  FilePickerService,
  AudioMetadataService,
  AudioPlayerService,
  OfflineQueueService,
  Book,
} from '../services'
import { MAIN_PLAYER_OWNER_ID } from '../utils'
import type { LibrarySlice, SetState, GetState } from './types'


export interface LibrarySliceDeps {
  db: DatabaseService
  files: FileStorageService
  picker: FilePickerService
  metadata: AudioMetadataService
  audio: AudioPlayerService
  queue: OfflineQueueService
}


export function createLibrarySlice(deps: LibrarySliceDeps) {
  const { db, files, picker, metadata, audio, queue } = deps

  return (set: SetState, get: GetState): LibrarySlice => {
    return {
      library: {
        status: 'loading',
      },
      books: {},

      fetchBooks,
      loadFile,
      loadFileWithUri,
      loadFileWithPicker,
      archiveBook,
    }

    function fetchBooks(): void {
      const books: Record<string, Book> = {}
      for (const book of db.getAllBooks()) {
        books[book.id] = book
      }

      set({ books, library: { status: 'idle' } })
    }

    async function archiveBook(bookId: string): Promise<void> {
      const { books } = get()
      const book = books[bookId]

      if (!book) {
        throw new Error('Book not found')
      }

      const previousUri = book.uri

      // 1. Optimistic store update
      set((state) => {
        state.books[bookId].uri = null
      })

      // 2. Database update (with rollback on fail)
      try {
        db.archiveBook(bookId)
        queue.queueChange('book', bookId, 'upsert')
      } catch (error) {
        // Rollback store
        set((state) => {
          state.books[bookId].uri = previousUri
        })
        throw error
      }

      // 3. Async file deletion (fire and forget - file is orphaned if this fails)
      if (previousUri) {
        files.deleteFile(previousUri).catch((error) => {
          console.error('Failed to delete archived book file (non-critical):', error)
        })
      }
    }

    async function loadFileWithUri(uri: string, name: string): Promise<void> {
      await loadFile({ uri, name })
    }

    async function loadFileWithPicker(): Promise<void> {
      const pickedFile = await picker.pickAudioFile()
      if (!pickedFile) return
      await loadFile(pickedFile)
    }

    async function loadFile(pickedFile: { uri: string; name: string }): Promise<void> {
      try {
        // Step 1: Copy file to app storage
        console.log('Copying file to app storage from:', pickedFile.uri)
        set({ library: { status: 'adding' } })

        const localUri = await files.copyToAppStorage(pickedFile.uri, pickedFile.name)
        console.log('File copied to:', localUri)

        // Step 2: Read metadata
        console.log('Reading metadata from:', localUri)
        const fileMeta = await metadata.readMetadata(localUri)
        console.log('Metadata read:', fileMeta)

        // Step 3: Read file fingerprint
        const { fileSize, fingerprint } = await files.readFileFingerprint(localUri)
        console.log('File fingerprint:', fileSize, 'bytes,', fingerprint.length, 'byte sample')

        // Step 4: Check for existing book with same fingerprint
        const existingBook = db.getBookByFingerprint(fileSize, fingerprint)

        // Verify file exists before loading
        const exists = await files.fileExists(localUri)
        console.log('Local file exists check:', exists, localUri)
        if (!exists) {
          throw new Error(`Local file does not exist: ${localUri}`)
        }

        // Step 5: Load audio from local URI
        set((state) => {
          state.library.status = 'idle'
          state.playback.status = 'loading'
        })

        console.log('Loading audio from:', localUri)
        const duration = await audio.load(localUri, {
          title: fileMeta.title,
          artist: fileMeta.artist,
          artwork: fileMeta.artwork,
        })
        console.log('Audio loaded successfully, duration:', duration)

        // Step 6: Determine which book record to use
        let book: Book

        if (existingBook) {
          if (existingBook.uri === null) {
            // Case A: Archived book - restore it with new file
            console.log('Restoring archived book:', existingBook.id)
            book = db.restoreBook(
              existingBook.id,
              localUri,
              pickedFile.name,
              duration,
              fileMeta.title,
              fileMeta.artist,
              fileMeta.artwork
            )
            queue.queueChange('book', book.id, 'upsert')
          } else {
            // Case B: Active book - delete duplicate file, use existing
            console.log('File already exists in library, removing duplicate:', localUri)
            await files.deleteFile(localUri)
            db.touchBook(existingBook.id)
            book = db.getBookById(existingBook.id)!
            queue.queueChange('book', book.id, 'upsert')

            // Reload audio from existing file
            await audio.load(book.uri!, {
              title: book.title,
              artist: book.artist,
              artwork: book.artwork,
            })
          }
        } else {
          // Case C: New book - create record
          console.log('Creating new book record')
          book = db.upsertBook(
            localUri,
            pickedFile.name,
            duration,
            0,
            fileMeta.title,
            fileMeta.artist,
            fileMeta.artwork,
            fileSize,
            fingerprint
          )
          queue.queueChange('book', book.id, 'upsert')
        }

        // Refresh books and clips in store
        fetchBooks()
        get().fetchClips()

        // Update state (keep status as 'loading' until play starts)
        set((state) => {
          state.playback.position = book.position
          state.playback.uri = book.uri!
          state.playback.duration = duration
        })

        // Seek to saved position
        if (book.position > 0) {
          await audio.seek(book.position)
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
        set((state) => {
          state.library.status = 'idle'
          state.playback.status = state.playback.uri ? 'paused' : 'idle'
        })
        throw error
      }
    }
  }
}
