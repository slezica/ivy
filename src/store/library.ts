import type {
  DatabaseService,
  FileStorageService,
  FilePickerService,
  AudioMetadataService,
  AudioPlayerService,
  SyncQueueService,
  BackupSyncService,
  Book,
  PlaybackStatus,
  SyncNotification,
} from '../services'
import type { LibrarySlice, SetState, GetState } from './types'
import { generateId, MAIN_PLAYER_OWNER_ID, throttle } from '../utils'


export interface LibrarySliceDeps {
  db: DatabaseService
  files: FileStorageService
  picker: FilePickerService
  metadata: AudioMetadataService
  audio: AudioPlayerService
  syncQueue: SyncQueueService
  sync: BackupSyncService
}


export function createLibrarySlice(deps: LibrarySliceDeps) {
  const { db, files, picker, metadata, audio, syncQueue, sync } = deps

  const queuePositionSync = throttle((bookId: string) => {
    syncQueue.queueChange('book', bookId, 'upsert')
  }, 30_000)

  return (set: SetState, get: GetState): LibrarySlice => {
    audio.on('status', onPlaybackStatus)
    sync.on('data', onSyncData)

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
      deleteBook,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      const { playback, books } = get()
      if (!playback.uri || status.position < 0 || status.duration <= 0) return
      if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

      const book = Object.values(books).find(b => b.uri === playback.uri)
      if (!book) return

      db.updateBookPosition(book.id, status.position)
      queuePositionSync(book.id)
    }

    function onSyncData(notification: SyncNotification) {
      if (notification.booksChanged.length > 0) {
        fetchBooks()
      }
    }

    function fetchBooks(): void {
      const books: Record<string, Book> = {}

      for (const book of db.getAllBooks()) {
        books[book.id] = book
      }

      set({ books, library: { status: 'idle' } })
    }

    async function archiveBook(bookId: string): Promise<void> {
      const book = get().books[bookId]
      if (!book) throw new Error('Book not found')

      const previousUri = book.uri

      try {
        set(state => {
          state.books[bookId].uri = null
        })

        db.archiveBook(bookId)
        syncQueue.queueChange('book', bookId, 'upsert')

      } catch (error) {
        set(state => {
          state.books[bookId].uri = previousUri
        })
        throw error
      }

      // Delete file (fire and forget, can clean up later if this fails):
      if (previousUri) {
        files.deleteFile(previousUri).catch((error) => {
          console.error('Failed to delete archived book file (non-critical):', error)
        })
      }
    }

    async function deleteBook(bookId: string): Promise<void> {
      const book = get().books[bookId]
      if (!book) throw new Error('Book not found')

      const previousBook = { ...book }

      try {
        set(state => {
          delete state.books[bookId]
        })

        db.hideBook(bookId)
        syncQueue.queueChange('book', bookId, 'upsert')

      } catch (error) {
        set((state) => {
          state.books[bookId] = previousBook
        })
        throw error
      }

      // Delete file (fire and forget, can clean up later if this fails):
      if (previousBook.uri) {
        files.deleteFile(previousBook.uri).catch((error) => {
          console.error('Failed to delete book file (non-critical):', error)
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

    async function loadFile(file: { uri: string; name: string }): Promise<void> {
      try {
        // Step 1: Copy file to app storage (with temp filename)
        console.log('Copying file to app storage from:', file.uri)
        set({ library: { status: 'adding' } })

        let tempUri = await files.copyToAppStorage(file.uri, file.name)
        console.log('File copied to:', tempUri)

        // Step 2: Read metadata
        const fileMeta = await metadata.readMetadata(tempUri)
        console.log('Metadata read:', fileMeta)

        // Step 3: Read file fingerprint
        const { fileSize, fingerprint } = await files.readFileFingerprint(tempUri)
        console.log('File fingerprint:', fileSize, 'bytes,', fingerprint.length, 'byte sample')

        // Step 4: Check for existing book with same fingerprint
        const existingBook = db.getBookByFingerprint(fileSize, fingerprint)

        // Step 5: Determine final ID and filename, save to database and schedule sync
        const { name } = file
        const { title, artist, artwork, duration } = fileMeta

        // TODO extract this 3-case conditional into 3 functions for readability
        if (existingBook) {
          if (existingBook.uri === null) {
            // Case A: Archived book - restore it with new file
            console.log('Restoring archived book:', existingBook.id)
            const uri = await files.rename(tempUri, existingBook.id)

            const book = db.restoreBook(existingBook.id, uri, name, duration, title, artist, artwork)
            syncQueue.queueChange('book', book.id, 'upsert')

          } else {
            // Case B: Active book - delete duplicate file, use existing
            console.log('File already exists in library, removing duplicate:', tempUri)
            await files.deleteFile(tempUri)

            db.touchBook(existingBook.id)
            const book = db.getBookById(existingBook.id)!

            console.log('Scheduling upsert for book', book.id)
            syncQueue.queueChange('book', book.id, 'upsert')
          }

        } else {
          // Case C: New book - generate ID, rename file, create record
          const id = generateId()
          const uri = await files.rename(tempUri, id)

          console.log('Creating new book with ID:', id)
          const book = db.upsertBook(id, uri, name, duration, 0, title, artist, artwork, fileSize, fingerprint)

          console.log('Scheduling upsert for book', book.id)
          syncQueue.queueChange('book', book.id, 'upsert')
        }

        fetchBooks()
        get().fetchClips()
        set(state => { state.library.status = 'idle' })

      } catch (error) {
        set(state => { state.library.status = 'idle' })
        console.error(error)
        throw error
      }
    }
  }
}
