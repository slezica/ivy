import type { DatabaseService, FileStorageService, FileCopierService, AudioMetadataService, SyncQueueService } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import type { CleanupOrphanedFiles } from './cleanup_orphaned_files'
import { generateId } from '../utils'

export interface LoadFileDeps {
  db: DatabaseService
  files: FileStorageService
  copier: FileCopierService
  metadata: AudioMetadataService
  syncQueue: SyncQueueService
  get: GetState
  set: SetState
  fetchBooks: FetchBooks
  fetchClips: FetchClips
  cleanupOrphanedFiles: CleanupOrphanedFiles
}

export type LoadFile = Action<[{ uri: string; name: string }]>

export const createLoadFile: ActionFactory<LoadFileDeps, LoadFile> = (deps) => (
  async (file) => {
    const { db, files, copier, metadata, syncQueue, get, set, fetchBooks, fetchClips, cleanupOrphanedFiles } = deps

    // Reclaim space from orphaned files before copying (best-effort)
    await cleanupOrphanedFiles().catch(() => {})

    let destPath: string | null = null

    // Allocate operation ID first — cancellable from this point
    const opId = copier.createOperation()

    // Helper: only update library state if this operation still owns it.
    // If the user cancelled and started a new add, we must not touch state.
    const setLibrary = (updater: (lib: typeof get extends () => infer S ? S extends { library: infer L } ? L : never : never) => void) => {
      set(state => {
        if (state.library.copyOpId === opId) {
          updater(state.library)
        }
      })
    }

    set(state => {
      state.library.status = 'adding'
      state.library.copyProgress = null
      state.library.copyOpId = opId
    })

    try {
      // Phase 1: Open the source and read fingerprint (no file created yet)
      const { fileSize, fingerprint } = await copier.beginCopy(opId, file.uri)

      // Check for an existing book with the same fingerprint
      const existingBook = db.getBookByFingerprint(fileSize, fingerprint)

      if (existingBook && existingBook.uri !== null) {
        // Case B: Active duplicate — don't copy at all
        await copier.cancelCopy(opId)

        db.touchBook(existingBook.id)
        syncQueue.queueChange('book', existingBook.id, 'upsert')

        await fetchBooks()
        await fetchClips()
        setLibrary(lib => {
          lib.status = 'duplicate'
          lib.copyProgress = null
          lib.copyOpId = null
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
        setLibrary(lib => {
          lib.copyProgress = { bytes, total }
        })
      })

      const fileUri = `file://${destPath}`

      // Read metadata from the copied file
      const fileMeta = await metadata.readMetadata(fileUri)
      const { title, artist, artwork, duration } = fileMeta
      const { name } = file

      if (existingBook) {
        // Case A: Restore archived/deleted book
        db.restoreBook(
          existingBook.id, fileUri, name, duration,
          existingBook.title ?? title,
          existingBook.artist ?? artist,
          existingBook.artwork ?? artwork,
        )
        syncQueue.queueChange('book', existingBook.id, 'upsert')

      } else {
        // Case C: New book
        db.upsertBook(bookId, fileUri, name, duration, 0, title, artist, artwork, fileSize, fingerprint)
        syncQueue.queueChange('book', bookId, 'upsert')
      }

      await fetchBooks()
      await fetchClips()
      setLibrary(lib => {
        lib.status = 'idle'
        lib.copyProgress = null
        lib.copyOpId = null
      })

    } catch (error) {
      // Clean up the destination file if it was created but the DB write failed
      if (destPath && !db.getBookByUri(`file://${destPath}`)) {
        await files.deleteFile(`file://${destPath}`).catch(() => {})
      }

      // User cancellation — silently done (cancelLoadFile already dismissed the UI)
      if (isCancellation(error)) return

      // Real error — show in dialog (only if we still own state)
      console.error('Failed to add file:', error)
      setLibrary(lib => {
        lib.status = 'error'
        lib.copyProgress = null
        lib.copyOpId = null
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
  return error instanceof Error && (error as any).code === 'CANCELLED'
}
