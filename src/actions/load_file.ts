import type { DatabaseService, FileStorageService, AudioMetadataService, SyncQueueService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import { generateId } from '../utils'


export interface LoadFileDeps {
  db: DatabaseService
  files: FileStorageService
  metadata: AudioMetadataService
  syncQueue: SyncQueueService
  set: SetState
  fetchBooks: FetchBooks
  fetchClips: FetchClips
}

export type LoadFile = Action<[{ uri: string; name: string }]>

export const createLoadFile: ActionFactory<LoadFileDeps, LoadFile> = (deps) => (
  async (file) => {
    const { db, files, metadata, syncQueue, set, fetchBooks, fetchClips } = deps

    let tempUri: string | null = null
    let permanentUri: string | null = null

    try {
      // Step 1: Copy file to app storage (with temp filename)
      console.log('Copying file to app storage from:', file.uri)
      set({ library: { status: 'adding' } })

      tempUri = await files.copyToAppStorage(file.uri, file.name)
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

      if (existingBook) {
        if (existingBook.uri === null) {
          // Case A: Archived book - restore it with new file
          console.log('Restoring archived book:', existingBook.id)
          permanentUri = await files.rename(tempUri, existingBook.id)

          const book = db.restoreBook(existingBook.id, permanentUri, name, duration, title, artist, artwork)
          syncQueue.queueChange('book', book.id, 'upsert')

        } else {
          // Case B: Active book - duplicate file, use existing
          console.log('File already exists in library, duplicate will be cleaned up:', tempUri)
          permanentUri = existingBook.uri

          db.touchBook(existingBook.id)
          const book = db.getBookById(existingBook.id)!

          console.log('Scheduling upsert for book', book.id)
          syncQueue.queueChange('book', book.id, 'upsert')
        }

      } else {
        // Case C: New book - generate ID, rename file, create record
        const id = generateId()
        permanentUri = await files.rename(tempUri, id)

        console.log('Creating new book with ID:', id)
        const book = db.upsertBook(id, permanentUri, name, duration, 0, title, artist, artwork, fileSize, fingerprint)

        console.log('Scheduling upsert for book', book.id)
        syncQueue.queueChange('book', book.id, 'upsert')
      }

      await fetchBooks()
      await fetchClips()
      set(state => { state.library.status = 'idle' })

    } catch (error) {
      set(state => { state.library.status = 'idle' })
      console.error(error)
      throw error

    } finally {
      // Whatever happened above, we must clean up unused files. Temporary files must always go,
      // and also "permanent" files that are actually not referenced from the DB (something failed).
      if (tempUri) {
        await files.deleteFile(tempUri).catch(() => {})
      }

      if (permanentUri && !db.getBookByUri(permanentUri)) {
        await files.deleteFile(permanentUri).catch(() => {})
      }
    }
  }
)
