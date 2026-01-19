import type {
  DatabaseService,
  FileStorageService,
  FilePickerService,
  AudioMetadataService,
  OfflineQueueService,
  Book,
} from '../services'
import type { LibrarySlice, SetState, GetState } from './types'


export interface LibrarySliceDeps {
  db: DatabaseService
  files: FileStorageService
  picker: FilePickerService
  metadata: AudioMetadataService
  queue: OfflineQueueService
}


export function createLibrarySlice(deps: LibrarySliceDeps) {
  const { db, files, picker, metadata, queue } = deps

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

        const duration = fileMeta.duration
        console.log('Duration from metadata:', duration)

        // Step 5: Determine which book record to use
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

        set({ library: { status: 'idle' } })
      } catch (error) {
        console.error(error)
        set({ library: { status: 'idle' } })
        throw error
      }
    }
  }
}
