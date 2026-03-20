import type { DatabaseService, FileStorageService, FileDownloaderService, AudioMetadataService, SyncQueueService } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import type { CleanupOrphanedFiles } from './cleanup_orphaned_files'
import { generateId } from '../utils'
import RNFS from 'react-native-fs'

export interface LoadFromUrlDeps {
  db: DatabaseService
  files: FileStorageService
  downloader: FileDownloaderService
  metadata: AudioMetadataService
  syncQueue: SyncQueueService
  get: GetState
  set: SetState
  fetchBooks: FetchBooks
  fetchClips: FetchClips
  cleanupOrphanedFiles: CleanupOrphanedFiles
}

export type LoadFromUrl = Action<[string]>

export const createLoadFromUrl: ActionFactory<LoadFromUrlDeps, LoadFromUrl> = (deps) => (
  async (url) => {
    const { db, files, downloader, metadata, syncQueue, get, set, fetchBooks, fetchClips, cleanupOrphanedFiles } = deps
    const log = (...args: any[]) => console.log('[LoadFromUrl]', ...args)

    log(`Starting: "${url}"`)

    // Reclaim space from orphaned files before downloading (best-effort)
    await cleanupOrphanedFiles().catch(() => {})

    const opId = generateId()

    // Helper: only update library state if this operation still owns it.
    const setLibrary = (updater: (lib: typeof get extends () => infer S ? S extends { library: infer L } ? L : never : never) => void) => {
      set(state => {
        if (state.library.addOpId === opId) {
          updater(state.library)
        }
      })
    }

    if (get().downloader.status !== 'idle') return

    set(state => {
      state.library.status = 'adding'
      state.library.addProgress = null
      state.library.addOpId = opId
      state.downloader.status = 'downloading'
    })

    // Download to a temp directory, then move to app storage
    const tempDir = `${RNFS.CachesDirectoryPath}/downloads`
    await RNFS.mkdir(tempDir)

    let downloadedPath: string | null = null

    try {
      // Phase 1: Download
      const { filePath } = await downloader.download(url, tempDir, (percent) => {
        if (percent < 0) return
        setLibrary(lib => {
          lib.addProgress = Math.min(Math.round(percent), 99)
        })
      })

      downloadedPath = filePath
      log(`Downloaded to: ${filePath}`)

      // Phase 2: Read fingerprint for duplicate detection
      const { fileSize, fingerprint } = await files.readFileFingerprint(`file://${filePath}`)
      const existingBook = db.getBookByFingerprint(fileSize, fingerprint)
      log(`Fingerprint lookup: fileSize=${fileSize}, match=${existingBook?.id ?? 'none'}`)

      if (existingBook && existingBook.uri !== null) {
        // Active duplicate — clean up download and report
        log(`Active duplicate of ${existingBook.id}, skipping`)
        await RNFS.unlink(filePath).catch(() => {})

        db.touchBook(existingBook.id)
        syncQueue.queueChange('book', existingBook.id, 'upsert')

        await fetchBooks()
        await fetchClips()
        set(state => { state.downloader.status = 'idle' })
        setLibrary(lib => {
          lib.status = 'duplicate'
          lib.addProgress = null
          lib.addOpId = null
        })
        return
      }

      // Phase 3: Move to app storage
      const bookId = existingBook?.id ?? generateId()
      const filename = getFilename(filePath)

      await files.ensureAudioDirectory()
      const destPath = `${files.audioDirectoryPath}/${sanitizeFilename(`${bookId}_${filename}`)}`
      await RNFS.moveFile(filePath, destPath)
      downloadedPath = null // No longer responsible for cleanup

      const fileUri = `file://${destPath}`

      // Phase 4: Read metadata
      const fileMeta = await metadata.readMetadata(fileUri)
      const { title, artist, artwork, duration } = fileMeta

      if (existingBook) {
        // Restore archived/deleted book
        log(`Restoring ${existingBook.id}`)
        db.restoreBook(
          existingBook.id, fileUri, filename, duration,
          existingBook.title ?? title,
          existingBook.artist ?? artist,
          existingBook.artwork ?? artwork,
        )
        syncQueue.queueChange('book', existingBook.id, 'upsert')
      } else {
        // New book
        log(`New book ${bookId}`)
        db.upsertBook(bookId, fileUri, filename, duration, 0, title, artist, artwork, fileSize, fingerprint)
        syncQueue.queueChange('book', bookId, 'upsert')
      }

      await fetchBooks()
      await fetchClips()
      set(state => { state.downloader.status = 'idle' })
      setLibrary(lib => {
        lib.status = 'idle'
        lib.addProgress = null
        lib.addOpId = null
      })

    } catch (error) {
      // Clean up downloaded file if it still exists
      if (downloadedPath) {
        await RNFS.unlink(downloadedPath).catch(() => {})
      }

      set(state => { state.downloader.status = 'idle' })

      if (isCancellation(error)) {
        log('Cancelled by user')
        return
      }

      log('Error:', error)
      setLibrary(lib => {
        lib.status = 'error'
        lib.addProgress = null
        lib.addOpId = null
      })
    }
  }
)


// =============================================================================
// Helpers
// =============================================================================

function getFilename(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1)
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\:*?"<>|[\]]/g, '_')
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error as any).code === 'CANCELLED'
}
