import type { DatabaseService, FileStorageService, FileCopierService, AudioMetadataService, SyncQueueService, Book } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'
import type { AppState } from '../store/types'
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
    const { copier, db, set, fetchBooks, fetchClips, cleanupOrphanedFiles } = deps

    // Unique operation ID for copy operations:
    const opId = copier.createOperation()

    // Helpers for sub-actions:
    const log = createTaggedLogger()
    const updateLibrary = createSafeLibraryUpdater(set, opId)
    const context = { ...deps, opId, updateLibrary, log }

    // Maintenance task, done here for convenience only, not needed for this action specifically:
    await cleanupOrphanedFiles().catch(() => {})

    log(`Starting: "${file.name}"`)

    set(state => {
      state.library.status = 'adding'
      state.library.addProgress = null
      state.library.addOpId = opId
      state.library.message = 'Copying'
    })

    // This action takes three possible paths below:
    // - When this is a duplicate book
    // - When this is a new book
    // - When an error occurs

    try {
      const { fileSize, fingerprint } = await copier.beginCopy(opId, file.uri)
      const existingBook = db.getBookByFingerprint(fileSize, fingerprint)

      if (existingBook?.uri) {
        await handleDuplicate(context, existingBook.id)
      } else {
        await handleNewBook(context, file, fileSize, fingerprint, existingBook)
      }

    } catch (error) {
      await handleError(context, error)

    } finally {
      // In all cases, make sure the store has the latest data:
      await fetchBooks()
      await fetchClips()
    }
  }
)


// =============================================================================
// Paths
// =============================================================================

type Context = LoadFileDeps & {
  opId: string
  updateLibrary: SafeLibraryUpdater
  log: (...args: any[]) => void
}

async function handleDuplicate(ctx: Context, bookId: string) {
  const { copier, db, syncQueue, opId, updateLibrary } = ctx

  await copier.cancelCopy(opId)

  db.touchBook(bookId)
  syncQueue.queueChange('book', bookId, 'upsert')

  updateLibrary(lib => {
    resetLibrary(lib)
    lib.status = 'duplicate'
  })
}

async function handleNewBook(
  ctx: Context,
  file: { uri: string; name: string },
  fileSize: number,
  fingerprint: Uint8Array,
  existingBook: Book | null | undefined,
) {
  const { db, files, metadata, syncQueue, updateLibrary } = ctx

  const bookId = existingBook?.id ?? generateId()
  const destPath = await copyFile(ctx, bookId, file.name)
  const fileUri = `file://${destPath}`

  try {
    const { title, artist, artwork, duration } = await metadata.readMetadata(fileUri)

    if (existingBook) {
      db.restoreBook(
        existingBook.id, fileUri, file.name, duration,
        existingBook.title ?? title,
        existingBook.artist ?? artist,
        existingBook.artwork ?? artwork,
        fileSize, fingerprint,
      )

      syncQueue.queueChange('book', existingBook.id, 'upsert')

    } else {
      db.upsertBook(bookId, fileUri, file.name, duration, 0, title, artist, artwork, fileSize, fingerprint)

      syncQueue.queueChange('book', bookId, 'upsert')
    }

    updateLibrary(resetLibrary)

  } catch (error) {
    // Clean up copied file if we fail after copying but before DB commit
    if (!db.getBookByUri(fileUri)) {
      await files.deleteFile(fileUri).catch(() => {})
    }
    throw error
  }
}

async function handleError(ctx: Context, error: unknown) {
  const { updateLibrary, log } = ctx

  if (isCancellation(error)) {
    log('Cancelled by user')
    return
  }

  log('Error:', error)
  updateLibrary(lib => {
    resetLibrary(lib)
    lib.status = 'error'
  })
}


// =============================================================================
// Helpers
// =============================================================================

type Library = AppState['library']
type SafeLibraryUpdater = (updater: (lib: Library) => void) => void

function resetLibrary(lib: Library) {
  lib.status = 'idle'
  lib.addProgress = null
  lib.addOpId = null
  lib.message = null
}

function createTaggedLogger() {
  return (...args: any[]) => console.log('[LoadFile]', ...args)
}

function createSafeLibraryUpdater(set: SetState, opId: string): SafeLibraryUpdater {
  return (updater) => {
    set(state => {
      if (state.library.addOpId === opId) {
        updater(state.library)
      }
    })
  }
}

async function copyFile(ctx: Context, bookId: string, originalName: string): Promise<string> {
  const { copier, files, opId, updateLibrary } = ctx
  const extension = getExtension(originalName)
  const filename = sanitizeFilename(`${bookId}${extension}`)

  await files.ensureAudioDirectory()
  const destPath = `${files.audioDirectoryPath}/${filename}`

  await copier.commitCopy(opId, destPath, (bytes, total) => {
    updateLibrary(lib => {
      lib.addProgress = total > 0 ? Math.round((bytes / total) * 100) : null
    })
  })

  return destPath
}

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
