import type { DatabaseService, FileStorageService, FileDownloaderService, AudioMetadataService, ChapterReaderService, SyncQueueService, Book } from '../services'
import type { GetState, SetState, Action, ActionFactory, AppState } from '../store/types'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import type { CleanupOrphanedFiles } from './cleanup_orphaned_files'
import { generateId, createLogger } from '../utils'
import RNFS from 'react-native-fs'

export interface LoadFromUrlDeps {
  db: DatabaseService
  files: FileStorageService
  downloader: FileDownloaderService
  metadata: AudioMetadataService
  chapters: ChapterReaderService
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
    const { db, files, set, get, fetchBooks, fetchClips, cleanupOrphanedFiles } = deps
    const log = createLogger('LoadFromUrl')

    if (get().downloader.status !== 'idle') return

    const opId = generateId()
    const updateLibrary = createSafeLibraryUpdater(set, opId)
    const context = { ...deps, opId, updateLibrary, log }

    // Maintenance task, done here for convenience only, not needed for this action specifically:
    await cleanupOrphanedFiles().catch(() => {})

    log(`Starting: "${url}"`)

    set(state => {
      state.library.status = 'adding'
      state.library.addProgress = null
      state.library.addOpId = opId
      state.library.message = 'Downloading'
      state.downloader.status = 'downloading'
    })

    // This action takes three possible paths below:
    // - When this is a duplicate book
    // - When this is a new book
    // - When an error occurs

    let downloadedPath: string | null = null

    try {
      downloadedPath = await downloadFile(context, url, updateLibrary)

      const { fileSize, fingerprint } = await files.readFileFingerprint(`file://${downloadedPath}`)
      const existingBook = await db.getBookByFingerprint(fileSize, fingerprint)

      if (existingBook?.uri) {
        await handleDuplicate(context, downloadedPath, existingBook.id)
        downloadedPath = null
      } else {
        await handleNewBook(context, downloadedPath, fileSize, fingerprint, existingBook)
        downloadedPath = null
      }

    } catch (error) {
      await handleError(context, error, downloadedPath)
    } finally {
      set(state => { state.downloader.status = 'idle' })
      await fetchBooks()
      await fetchClips()
    }
  }
)


// =============================================================================
// Paths
// =============================================================================

type Context = LoadFromUrlDeps & {
  opId: string
  updateLibrary: SafeLibraryUpdater
  log: (...args: any[]) => void
}

async function handleDuplicate(ctx: Context, downloadedPath: string, bookId: string) {
  const { db, syncQueue, updateLibrary } = ctx

  await RNFS.unlink(downloadedPath).catch(() => {})

  await db.touchBook(bookId)
  await syncQueue.queueChange('book', bookId, 'upsert')

  updateLibrary(lib => {
    resetLibrary(lib)
    lib.status = 'duplicate'
  })
}

async function handleNewBook(
  ctx: Context,
  downloadedPath: string,
  fileSize: number,
  fingerprint: Uint8Array,
  existingBook: Book | null | undefined,
) {
  const { db, files, metadata, chapters: chapterReader, syncQueue, updateLibrary } = ctx

  const bookId = existingBook?.id ?? generateId()
  const destPath = await moveToAppStorage(files, downloadedPath, bookId)
  const fileUri = `file://${destPath}`
  const filename = getFilename(downloadedPath)

  const [{ title, artist, artwork, duration }, chapters] = await Promise.all([
    metadata.readMetadata(fileUri),
    chapterReader.readChapters(fileUri),
  ])

  if (existingBook) {
    await db.restoreBook(
      existingBook.id, fileUri, filename, duration,
      existingBook.title ?? title,
      existingBook.artist ?? artist,
      existingBook.artwork ?? artwork,
      fileSize, fingerprint,
      chapters,
    )
    await syncQueue.queueChange('book', existingBook.id, 'upsert')
  } else {
    await db.upsertBook(bookId, fileUri, filename, duration, 0, title, artist, artwork, fileSize, fingerprint, chapters)
    await syncQueue.queueChange('book', bookId, 'upsert')
  }

  updateLibrary(resetLibrary)
}

async function handleError(ctx: Context, error: unknown, downloadedPath: string | null) {
  const { updateLibrary, log } = ctx

  if (downloadedPath) {
    await RNFS.unlink(downloadedPath).catch(() => {})
  }

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

function createSafeLibraryUpdater(set: SetState, opId: string): SafeLibraryUpdater {
  return (updater) => {
    set(state => {
      if (state.library.addOpId === opId) {
        updater(state.library)
      }
    })
  }
}

async function downloadFile(ctx: Context, url: string, updateLibrary: SafeLibraryUpdater): Promise<string> {
  const { downloader } = ctx

  const tempDir = `${RNFS.CachesDirectoryPath}/downloads`
  await RNFS.mkdir(tempDir)

  const { filePath } = await downloader.download(url, tempDir, (percent) => {
    if (percent < 0) return
    updateLibrary(lib => {
      lib.addProgress = Math.min(Math.round(percent), 99)
      if (Math.round(percent) >= 100) {
        lib.message = 'Extracting audio'
      }
    })
  })

  return filePath
}

async function moveToAppStorage(files: FileStorageService, sourcePath: string, bookId: string): Promise<string> {
  const filename = getFilename(sourcePath)

  await files.ensureAudioDirectory()
  const destPath = `${files.audioDirectoryPath}/${sanitizeFilename(`${bookId}_${filename}`)}`
  await RNFS.moveFile(sourcePath, destPath)

  return destPath
}

function getFilename(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1)
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\:*?"<>|[\]]/g, '_')
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error as any).code === 'CANCELLED'
}
