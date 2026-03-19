import type { DatabaseService, FileStorageService, FileCopierService, AudioMetadataService, SyncQueueService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import { generateId } from '../utils'

const AUDIO_DIR = 'audio'

export interface LoadFileDeps {
  db: DatabaseService
  files: FileStorageService
  copier: FileCopierService
  metadata: AudioMetadataService
  syncQueue: SyncQueueService
  set: SetState
  fetchBooks: FetchBooks
  fetchClips: FetchClips
}

export type LoadFile = Action<[{ uri: string; name: string }]>

export const createLoadFile: ActionFactory<LoadFileDeps, LoadFile> = (deps) => (
  async (file) => {
    const { db, files, copier, metadata, syncQueue, set, fetchBooks, fetchClips } = deps

    let destPath: string | null = null

    try {
      // Allocate operation ID first — cancellable from this point
      const opId = copier.createOperation()

      set(state => {
        state.library.status = 'adding'
        state.library.copyProgress = null
        state.library.copyOpId = opId
      })

      // Phase 1: Open the source and read fingerprint (no file created yet)
      const { fileSize, fingerprint } = await copier.beginCopy(opId, file.uri)

      // Check for an existing book with the same fingerprint
      const existingBook = db.getBookByFingerprint(fileSize, fingerprint)

      if (existingBook && existingBook.uri !== null) {
        // Case B: Active duplicate — don't copy at all
        console.log('File already exists in library:', existingBook.id)
        await copier.cancelCopy(opId)

        db.touchBook(existingBook.id)
        syncQueue.queueChange('book', existingBook.id, 'upsert')

        await fetchBooks()
        await fetchClips()
        set(state => {
          state.library.status = 'duplicate'
          state.library.copyProgress = null
          state.library.copyOpId = null
        })
        return
      }

      // Case A (restore) or Case C (new book) — we need the file
      const bookId = existingBook?.id ?? generateId()
      const extension = getExtension(file.name)
      const filename = sanitizeFilename(`${bookId}${extension}`)

      await files.ensureAudioDirectory()
      destPath = `${files.audioDirectoryPath}/${filename}`

      const { hash } = await copier.commitCopy(opId, destPath, (bytes, total) => {
        set(state => {
          state.library.copyProgress = { bytes, total }
        })
      })

      const fileUri = `file://${destPath}`

      // Read metadata from the copied file
      const fileMeta = await metadata.readMetadata(fileUri)
      const { title, artist, artwork, duration } = fileMeta
      const { name } = file

      if (existingBook) {
        // Case A: Restore archived/deleted book
        console.log('Restoring archived book:', existingBook.id)
        db.restoreBook(
          existingBook.id, fileUri, name, duration,
          existingBook.title ?? title,
          existingBook.artist ?? artist,
          existingBook.artwork ?? artwork,
        )
        syncQueue.queueChange('book', existingBook.id, 'upsert')

      } else {
        // Case C: New book
        console.log('Creating new book with ID:', bookId)
        db.upsertBook(bookId, fileUri, name, duration, 0, title, artist, artwork, fileSize, fingerprint)
        syncQueue.queueChange('book', bookId, 'upsert')
      }

      await fetchBooks()
      await fetchClips()
      set(state => {
        state.library.status = 'idle'
        state.library.copyProgress = null
      })

    } catch (error) {
      // Clean up the destination file if it was created but the DB write failed
      if (destPath && !db.getBookByUri(`file://${destPath}`)) {
        await files.deleteFile(`file://${destPath}`).catch(() => {})
      }

      // User cancellation — silently dismiss
      if (isCancellation(error)) {
        set(state => {
          state.library.status = 'idle'
          state.library.copyProgress = null
          state.library.copyOpId = null
        })
        return
      }

      // Real error — show in dialog
      console.error('Failed to add file:', error)
      set(state => {
        state.library.status = 'error'
        state.library.copyProgress = null
        state.library.copyOpId = null
      })
    }
  }
)


// =============================================================================
// Helpers
// =============================================================================

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex >= 0 ? filename.substring(dotIndex) : ''
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\:*?"<>|[\]]/g, '_')
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('CANCELLED')
}
